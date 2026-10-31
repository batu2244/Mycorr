import Anthropic from "@anthropic-ai/sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import type { ModelProvider, StructuredRequest, StructuredResult } from "./types.js"

export interface AnthropicProviderOptions {
  apiKey?: string
  modelId: string
  effort: "low" | "medium" | "high"
}

/**
 * Real provider. Uses structured outputs (output_config.format) so the response is
 * schema-constrained, then re-validates with Zod before returning. Falls back to
 * plain JSON-in-text if the schema cannot be expressed as a structured-output format.
 */
export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic"
  readonly modelId: string
  private readonly client: Anthropic
  private readonly effort: "low" | "medium" | "high"

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {})
    this.modelId = options.modelId
    this.effort = options.effort
  }

  async complete<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const maxTokens = request.maxTokens ?? 8000
    const usage = { inputTokens: 0, outputTokens: 0 }
    try {
      let format: ReturnType<typeof zodOutputFormat> | undefined
      try {
        format = zodOutputFormat(request.schema as never)
      } catch {
        format = undefined
      }
      const response = format
        ? await this.client.messages.parse({
            model: this.modelId,
            max_tokens: maxTokens,
            output_config: { effort: this.effort, format },
            system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: request.user }],
          })
        : await this.client.messages.create({
            model: this.modelId,
            max_tokens: maxTokens,
            output_config: { effort: this.effort },
            system: [
              { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
              { type: "text", text: "Respond with a single JSON object and nothing else." },
            ],
            messages: [{ role: "user", content: request.user }],
          })
      usage.inputTokens = response.usage.input_tokens
      usage.outputTokens = response.usage.output_tokens
      if (response.stop_reason === "refusal") {
        return { ok: false, error: `model refused: ${response.stop_details?.explanation ?? "no explanation"}`, retryable: false, usage }
      }
      if (response.stop_reason === "max_tokens") {
        return { ok: false, error: "model output truncated (max_tokens)", retryable: true, usage }
      }
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("")
      const candidate = "parsed_output" in response && response.parsed_output != null ? response.parsed_output : extractJson(text)
      const parsed = request.schema.safeParse(candidate)
      if (!parsed.success) {
        return { ok: false, error: `model output failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, retryable: true, usage, raw: text }
      }
      return { ok: true, value: parsed.data, usage, raw: text }
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) return { ok: false, error: "rate limited", retryable: true, usage }
      if (error instanceof Anthropic.AuthenticationError) return { ok: false, error: "invalid ANTHROPIC_API_KEY", retryable: false, usage }
      if (error instanceof Anthropic.BadRequestError) return { ok: false, error: `bad request: ${error.message}`, retryable: false, usage }
      if (error instanceof Anthropic.APIError) return { ok: false, error: `api error ${error.status}: ${error.message}`, retryable: (error.status ?? 500) >= 500, usage }
      if (error instanceof Anthropic.APIConnectionError) return { ok: false, error: `connection error: ${error.message}`, retryable: true, usage }
      return { ok: false, error: error instanceof Error ? error.message : String(error), retryable: false, usage }
    }
  }
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
