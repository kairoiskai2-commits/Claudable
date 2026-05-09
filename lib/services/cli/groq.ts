/**
 * Groq CLI Service
 * Uses AI SDK with Groq provider for fast LLM inference.
 */

import { generateText, streamText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Message } from '@/types/backend';
import type { RealtimeMessage } from '@/types';
import { streamManager } from '@/lib/services/stream';
import { createMessage } from '@/lib/services/message';
import { getProjectById } from '@/lib/services/project';
import { serializeMessage, createRealtimeMessage } from '@/lib/serializers/chat';
import { loadGlobalSettings } from '@/lib/services/settings';
import {
  markUserRequestAsRunning,
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
} from '@/lib/services/user-requests';
import {
  GROQ_DEFAULT_MODEL,
  getGroqModelDisplayName,
  normalizeGroqModelId,
} from '@/lib/constants/groqModels';

const STATUS_LABELS: Record<string, string> = {
  starting: 'Initializing Groq...',
  ready: 'Groq runtime ready',
  running: 'Groq is processing your request...',
  completed: 'Groq execution completed',
};

const SYSTEM_PROMPT = `You are an expert AI coding assistant. You help users build web applications.
You have expertise in:
- Next.js (App Router with TypeScript)
- React and modern JavaScript/TypeScript
- Tailwind CSS for styling
- Database operations and API design

When helping with code:
1. Write clean, well-structured code
2. Follow best practices and conventions
3. Explain your approach briefly
4. Provide complete, working solutions

Be concise but thorough. Focus on practical, implementable solutions.`;

type StreamAccumulator = {
  id: string;
  content: string;
  createdAt: string;
  isStreaming: boolean;
};

async function ensureProjectPath(projectId: string, projectPath: string): Promise<string> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const absolute = path.isAbsolute(projectPath)
    ? path.resolve(projectPath)
    : path.resolve(process.cwd(), projectPath);
  const allowedBasePath = path.resolve(process.cwd(), process.env.PROJECTS_DIR || './data/projects');
  const relativeToBase = path.relative(allowedBasePath, absolute);
  const isWithinBase = !relativeToBase.startsWith('..') && !path.isAbsolute(relativeToBase);
  if (!isWithinBase) {
    throw new Error(`Project path must be within ${allowedBasePath}. Got: ${absolute}`);
  }

  try {
    await fs.access(absolute);
  } catch {
    await fs.mkdir(absolute, { recursive: true });
  }

  return absolute;
}

async function appendProjectContext(baseInstruction: string, repoPath: string): Promise<string> {
  try {
    const entries = await fs.readdir(repoPath, { withFileTypes: true });
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.git') && entry.name !== 'AGENTS.md')
      .map((entry) => entry.name);

    if (visible.length === 0) {
      return `${baseInstruction}

<current_project_context>
This is an empty project directory. Work directly in the current folder without creating extra subdirectories.
</current_project_context>`;
    }

    return `${baseInstruction}

<current_project_context>
Current files in project directory: ${visible.sort().join(', ')}
Work directly in the current directory. Do not create subdirectories unless specifically requested.
</current_project_context>`;
  } catch (error) {
    console.warn('[GroqService] Failed to append project context:', error);
    return baseInstruction;
  }
}

function publishStatus(projectId: string, status: string, requestId?: string, message?: string) {
  streamManager.publish(projectId, {
    type: 'status',
    data: {
      status,
      message: message ?? STATUS_LABELS[status] ?? '',
      ...(requestId ? { requestId } : {}),
    },
  });
}

async function persistAssistantMessage(
  projectId: string,
  payload: {
    role: Message['role'];
    messageType: Message['messageType'];
    content: string;
    metadata?: Record<string, unknown> | null;
  },
  requestId?: string,
  overrides?: Partial<RealtimeMessage>,
) {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const saved = await createMessage({
        projectId,
        role: payload.role,
        messageType: payload.messageType,
        content: payload.content,
        metadata: payload.metadata ?? null,
        cliSource: 'groq',
        requestId,
      });

      streamManager.publish(projectId, {
        type: 'message',
        data: serializeMessage(saved, {
          ...(requestId ? { requestId } : {}),
          ...(overrides ?? {}),
        }),
      });

      console.log(`[GroqService] Successfully persisted message on attempt ${attempt}`);
      return;
    } catch (error) {
      lastError = error as Error;
      console.error(`[GroqService] Attempt ${attempt} failed to persist assistant message:`, error);

      if (attempt < 3) {
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        console.log(`[GroqService] Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error('[GroqService] All retry attempts failed. Falling back to realtime emit:', lastError);
  const fallback = createRealtimeMessage({
    projectId,
    role: payload.role,
    messageType: payload.messageType,
    content: payload.content,
    metadata: payload.metadata ?? null,
    cliSource: 'groq',
    requestId,
    ...(overrides ?? {}),
  });
  streamManager.publish(projectId, {
    type: 'message',
    data: fallback,
  });
}

function createStreamAccumulator(requestId?: string): StreamAccumulator {
  return {
    id: requestId ? `groq-stream-${requestId}` : `groq-stream-${randomUUID()}`,
    content: '',
    createdAt: new Date().toISOString(),
    isStreaming: false,
  };
}

function emitStreamingUpdate(projectId: string, accumulator: StreamAccumulator, requestId?: string, isFinal: boolean = false) {
  const realtime = createRealtimeMessage({
    id: accumulator.id,
    projectId,
    role: 'assistant',
    messageType: 'chat',
    content: accumulator.content,
    metadata: { cli_type: 'groq' },
    cliSource: 'groq',
    requestId,
    createdAt: accumulator.createdAt,
    isStreaming: !isFinal,
    isFinal,
    isOptimistic: true,
  });
  streamManager.publish(projectId, { type: 'message', data: realtime });
  accumulator.isStreaming = !isFinal;
}

export async function executeGroq(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string,
  sessionId?: string,
  requestId?: string,
): Promise<void> {
  const normalizedModel = normalizeGroqModelId(model);
  const modelDisplayName = getGroqModelDisplayName(normalizedModel);

  // Load API key from global settings
  let configuredApiKey: string | undefined;
  try {
    const globalSettings = await loadGlobalSettings();
    const groqSettings = globalSettings.cli_settings?.groq;
    if (groqSettings && typeof groqSettings === 'object') {
      const candidate = (groqSettings as Record<string, unknown>).apiKey;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        configuredApiKey = candidate.trim();
      }
    }
  } catch (error) {
    console.warn('[GroqService] Failed to load Groq settings:', error);
  }

  // Use environment variable as fallback
  const apiKey = configuredApiKey || process.env.GROQ_API_KEY;
  
  if (!apiKey) {
    const errorMessage = 'Groq API key not configured. Please add your API key in Settings > AI Providers.';
    publishStatus(projectId, 'error', requestId, errorMessage);
    if (requestId) {
      await markUserRequestAsFailed(requestId, errorMessage);
    }
    await persistAssistantMessage(
      projectId,
      {
        role: 'assistant',
        messageType: 'chat',
        content: errorMessage,
        metadata: { cli_type: 'groq', error: true },
      },
      requestId,
    );
    return;
  }

  publishStatus(projectId, 'starting', requestId);
  if (requestId) {
    await markUserRequestAsRunning(requestId);
  }

  const absoluteProjectPath = await ensureProjectPath(projectId, projectPath);
  const repoPath = await (async () => {
    const candidate = path.join(absoluteProjectPath, 'repo');
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // ignore
    }
    return absoluteProjectPath;
  })();

  publishStatus(projectId, 'ready', requestId, `Groq detected (${modelDisplayName}). Starting execution...`);

  const promptWithContext = await appendProjectContext(instruction, repoPath);
  const accumulator = createStreamAccumulator(requestId);

  try {
    publishStatus(projectId, 'running', requestId);

    const groq = createGroq({
      apiKey,
    });

    const result = streamText({
      model: groq(normalizedModel),
      system: SYSTEM_PROMPT,
      prompt: promptWithContext,
      maxTokens: 4096,
    });

    for await (const chunk of result.textStream) {
      if (chunk) {
        accumulator.content += chunk;
        emitStreamingUpdate(projectId, accumulator, requestId, false);
      }
    }

    // Finalize the stream
    if (accumulator.content.trim().length > 0) {
      emitStreamingUpdate(projectId, accumulator, requestId, true);
      await persistAssistantMessage(
        projectId,
        {
          role: 'assistant',
          messageType: 'chat',
          content: accumulator.content.trim(),
          metadata: { cli_type: 'groq', model: normalizedModel },
        },
        requestId,
        { isStreaming: false, isFinal: true, isOptimistic: false },
      );
    }

    publishStatus(projectId, 'completed', requestId, 'Groq execution completed successfully');
    if (requestId) {
      await markUserRequestAsCompleted(requestId);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[GroqService] Error during execution:', error);
    
    publishStatus(projectId, 'error', requestId, `Groq error: ${errorMessage}`);
    
    if (requestId) {
      await markUserRequestAsFailed(requestId, errorMessage);
    }

    await persistAssistantMessage(
      projectId,
      {
        role: 'assistant',
        messageType: 'chat',
        content: `Error: ${errorMessage}`,
        metadata: { cli_type: 'groq', error: true },
      },
      requestId,
    );
  }
}

export { GROQ_DEFAULT_MODEL, normalizeGroqModelId, getGroqModelDisplayName };
