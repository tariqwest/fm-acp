import { z } from "zod";

export const ModelIdSchema = z.enum(["system", "pcc"]);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const BackendIdSchema = z.enum(["auto", "afm", "fm"]);
export type BackendId = z.infer<typeof BackendIdSchema>;

export const UseCaseSchema = z.enum(["general", "content-tagging"]);
export type UseCase = z.infer<typeof UseCaseSchema>;

export const GuardrailsSchema = z.enum([
  "default",
  "permissive-content-transformations",
]);
export type Guardrails = z.infer<typeof GuardrailsSchema>;

export const HistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

export const StoredSessionSchema = z.object({
  modelId: ModelIdSchema.nullable().optional(),
  backendId: BackendIdSchema.nullable().optional(),
  instructions: z.string().nullable().optional(),
  useCase: UseCaseSchema.nullable().optional(),
  guardrails: GuardrailsSchema.nullable().optional(),
  greedy: z.boolean().nullable().optional(),
  bridgeEnabled: z.boolean().nullable().optional(),
  cwd: z.string().optional(),
  transcriptPath: z.string().nullable().optional(),
  history: z.array(HistoryMessageSchema).default([]),
  seenKeys: z.array(z.string()).default([]),
  title: z.string().nullable().optional(),
  /** ISO 8601 last activity timestamp */
  updatedAt: z.string().nullable().optional(),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

export const SessionStoreSchema = z.object({
  sessions: z.record(z.string(), StoredSessionSchema).default({}),
});
export type SessionStoreFile = z.infer<typeof SessionStoreSchema>;

export type Session = {
  modelId: ModelId | null;
  backendId: BackendId | null;
  instructions: string | null;
  useCase: UseCase | null;
  guardrails: Guardrails | null;
  greedy: boolean | null;
  bridgeEnabled: boolean | null;
  cwd: string;
  transcriptPath: string | null;
  history: HistoryMessage[];
  seenKeys: Set<string>;
  title: string | null;
  updatedAt: string | null;
  activeAbort: AbortController | null;
};

export type ModelAvailability = {
  id: ModelId;
  available: boolean;
  runnableInCurrentProcess: boolean;
  reason?: string | null;
};

export type PromptImage = {
  path: string;
  label?: string;
};

export type PromptTurnRequest = {
  prompt: string;
  images?: PromptImage[];
  modelId: ModelId;
  instructions?: string | null;
  useCase?: UseCase | null;
  guardrails?: Guardrails | null;
  greedy?: boolean | null;
  transcriptPath?: string | null;
  /** Prior turns for backends without durable multi-turn files. */
  history?: HistoryMessage[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
};

export type PromptTurnResult = {
  text: string;
  backend: "afm" | "fm" | "afm-bridge" | "fm-helper" | "fm-serve";
  transcriptPath?: string | null;
};

export class FmAcpError extends Error {
  readonly code: number;
  readonly details?: string;

  constructor(message: string, opts: { code?: number; details?: string } = {}) {
    super(message);
    this.name = "FmAcpError";
    this.code = opts.code ?? -32000;
    this.details = opts.details;
  }
}
