import OpenAI from "openai"
import { zodTextFormat } from "openai/helpers/zod"
import type { ModelProvider, StructuredRequest, StructuredResult } from "./types.js"

export type OpenAIEffort = "low" | "medium" | "high"

export interface OpenAIProviderOptions {
  apiKey?: string
  baseURL?: string
  modelId: string
  effort: OpenAIEffort
}

/**
 * Real provider. Uses the Responses API with a Zod text format so the output is
 * schema-constrained, then re-validates with Zod before returning. Refusals,
 * truncation, and transport errors are reported as structured failures. Nothing
 * here ever falls back to the mock provider.
 */
export class OpenAIModelProvider implements ModelProvider {
  readonly name = "openai"
  readonly modelId: string
  private readonly client: OpenAI
  private readonly effort: OpenAIEffort

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    })
    this.modelId = options.modelId
    this.effort = options.effort
  }

  async complete<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const maxOutputTokens = request.maxTokens ?? 8000
    const usage = { inputTokens: 0, outputTokens: 0 }
    try {
      const response = await this.client.responses.parse({
        model: this.modelId,
        instructions: request.system,
        input: request.user,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: this.effort },
        text: { format: zodTextFormat(request.schema as never, request.schemaName) },
      })
      usage.inputTokens = response.usage?.input_tokens ?? 0
      usage.outputTokens = response.usage?.output_tokens ?? 0

      const refusal = findRefusal(response.output)
      if (refusal !== undefined) {
        return { ok: false, error: `model refused: ${refusal || "no explanation"}`, retryable: false, usage }
      }
      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason ?? "unknown"
        return { ok: false, error: `model output incomplete (${reason})`, retryable: reason === "max_output_tokens", usage, raw: response.output_text }
      }

      const candidate = response.output_parsed ?? extractJson(response.output_text)
      const parsed = request.schema.safeParse(candidate)
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        return { ok: false, error: `model output failed validation: ${issues}`, retryable: true, usage, raw: response.output_text }
      }
      return { ok: true, value: parsed.data, usage, raw: response.output_text }
    } catch (error) {
      if (error instanceof OpenAI.RateLimitError) return { ok: false, error: "rate limited", retryable: true, usage }
      if (error instanceof OpenAI.AuthenticationError) return { ok: false, error: "invalid OPENAI_API_KEY", retryable: false, usage }
      if (error instanceof OpenAI.BadRequestError) return { ok: false, error: `bad request: ${error.message}`, retryable: false, usage }
      if (error instanceof OpenAI.APIConnectionError) return { ok: false, error: `connection error: ${error.message}`, retryable: true, usage }
      if (error instanceof OpenAI.APIError) return { ok: false, error: `api error ${error.status}: ${error.message}`, retryable: (error.status ?? 500) >= 500, usage }
      return { ok: false, error: error instanceof Error ? error.message : String(error), retryable: false, usage }
    }
  }
}

/** Returns the refusal text if any output message contains a refusal item, else undefined. */
function findRefusal(output: OpenAI.Responses.ResponseOutputItem[]): string | undefined {
  for (const item of output) {
    if (item.type !== "message") continue
    for (const part of item.content) {
      if (part.type === "refusal") return part.refusal
    }
  }
  return undefined
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}
