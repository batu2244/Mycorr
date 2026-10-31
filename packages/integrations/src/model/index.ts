import type { Env } from "../config.js"
import { modelProviderFor } from "../config.js"
import { AnthropicModelProvider } from "./anthropic.js"
import { MockModelProvider } from "./mock.js"
import type { ModelProvider } from "./types.js"

export * from "./types.js"
export { AnthropicModelProvider } from "./anthropic.js"
export { MockModelProvider, mockQuestionTurn, mockPersonalTurn } from "./mock.js"

/** Picks the provider from env. In integrated mode a missing key is an error, never a silent mock. */
export function createModelProvider(env: Env): ModelProvider {
  const which = modelProviderFor(env)
  if (which === "mock") return new MockModelProvider()
  if (!env.ANTHROPIC_API_KEY) throw new Error("MODEL provider is anthropic but ANTHROPIC_API_KEY is not set (set MYCORR_MODE=mock to run without it)")
  return new AnthropicModelProvider({ apiKey: env.ANTHROPIC_API_KEY, modelId: env.MODEL_ID, effort: env.MODEL_EFFORT })
}
