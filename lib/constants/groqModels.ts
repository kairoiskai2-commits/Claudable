/**
 * Groq Model Definitions
 * Free tier models available through Groq's API for fast inference.
 */

export type GroqModelId =
  | 'llama-3.3-70b-versatile'
  | 'llama-3.1-8b-instant'
  | 'llama-3.2-90b-vision-preview'
  | 'mixtral-8x7b-32768'
  | 'gemma2-9b-it';

export interface GroqModelDefinition {
  id: GroqModelId;
  /** Human friendly display name */
  name: string;
  /** Optional longer description */
  description?: string;
  /** Whether the model can accept images */
  supportsImages?: boolean;
  /** Acceptable alias strings that should resolve to this model id */
  aliases: string[];
}

export const GROQ_MODEL_DEFINITIONS: GroqModelDefinition[] = [
  {
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B',
    description: 'Meta\'s most capable open model, great for coding and reasoning',
    supportsImages: false,
    aliases: [
      'llama-3.3-70b-versatile',
      'llama-3.3-70b',
      'llama3.3-70b',
      'llama-70b',
      'llama3-70b',
    ],
  },
  {
    id: 'llama-3.1-8b-instant',
    name: 'Llama 3.1 8B Instant',
    description: 'Fast and efficient for quick tasks',
    supportsImages: false,
    aliases: [
      'llama-3.1-8b-instant',
      'llama-3.1-8b',
      'llama3.1-8b',
      'llama-8b',
      'llama3-8b',
    ],
  },
  {
    id: 'llama-3.2-90b-vision-preview',
    name: 'Llama 3.2 90B Vision',
    description: 'Vision-capable model for image understanding',
    supportsImages: true,
    aliases: [
      'llama-3.2-90b-vision-preview',
      'llama-3.2-90b-vision',
      'llama-90b-vision',
      'llama-vision',
    ],
  },
  {
    id: 'mixtral-8x7b-32768',
    name: 'Mixtral 8x7B',
    description: 'Mistral\'s mixture of experts model with 32k context',
    supportsImages: false,
    aliases: [
      'mixtral-8x7b-32768',
      'mixtral-8x7b',
      'mixtral',
    ],
  },
  {
    id: 'gemma2-9b-it',
    name: 'Gemma 2 9B',
    description: 'Google\'s efficient open model',
    supportsImages: false,
    aliases: [
      'gemma2-9b-it',
      'gemma2-9b',
      'gemma2',
      'gemma',
    ],
  },
];

export const GROQ_DEFAULT_MODEL: GroqModelId = 'llama-3.3-70b-versatile';

const GROQ_MODEL_ALIAS_MAP: Record<string, GroqModelId> = GROQ_MODEL_DEFINITIONS.reduce(
  (map, definition) => {
    definition.aliases.forEach(alias => {
      const key = alias.trim().toLowerCase().replace(/[\s_]+/g, '-');
      map[key] = definition.id;
    });
    map[definition.id.toLowerCase()] = definition.id;
    return map;
  },
  {} as Record<string, GroqModelId>
);

export function normalizeGroqModelId(model?: string | null): GroqModelId {
  if (!model) return GROQ_DEFAULT_MODEL;
  const normalized = model.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return GROQ_MODEL_ALIAS_MAP[normalized] ?? GROQ_DEFAULT_MODEL;
}

export function getGroqModelDefinition(id: string): GroqModelDefinition | undefined {
  return (
    GROQ_MODEL_DEFINITIONS.find(def => def.id === id) ??
    GROQ_MODEL_DEFINITIONS.find(def =>
      def.aliases.some(alias => alias.toLowerCase() === id.toLowerCase())
    )
  );
}

export function getGroqModelDisplayName(id: string): string {
  return getGroqModelDefinition(id)?.name ?? id;
}
