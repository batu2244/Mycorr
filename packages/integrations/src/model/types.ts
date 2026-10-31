import type { z } from "zod"

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
}

export interface StructuredRequest<T> {
  /** Stable instructions; placed first for prompt caching. */
  system: string
  /** User-turn content, usually the serialized context. */
  user: string
  /** Zod schema the response must satisfy. */
  schema: z.ZodType<T>
  schemaName: string
  maxTokens?: number
}

export type StructuredResult<T> =
  | { ok: true; value: T; usage: ModelUsage; raw: string }
  | { ok: false; error: string; retryable: boolean; usage: ModelUsage; raw?: string }

/**
 * The one model-provider seam. Both the question agent and the personal agent
 * ask for a schema-constrained JSON object and validate it with Zod regardless
 * of which provider produced it.
 */
export interface ModelProvider {
  readonly name: string
  readonly modelId: string
  complete<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>
}
