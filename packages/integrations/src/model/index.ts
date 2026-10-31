import type { Env } from "../config.js"
import { modelProviderFor } from "../config.js"
import { OpenAIModelProvider } from "./openai.js"
import { MockModelProvider } from "./mock.js"
import type { ModelProvider } from "./types.js"

export * from "./types.js"
export { OpenAIModelProvider } from "./openai.js"
export { MockModelProvider, mockQuestionTurn, mockPersonalTurn } from "./mock.js"

/** Picks the provider from env. In integrated mode a missing key is an error, never a silent mock. */
export function createModelProvider(env: Env): ModelProvider {
  const which = modelProviderFor(env)
  if (which === "mock") return new MockModelProvider()
  if (!env.OPENAI_API_KEY) throw new Error("MODEL provider is openai but OPENAI_API_KEY is not set (set MYCORR_MODE=mock to run without it)")
  return new OpenAIModelProvider({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, modelId: env.MODEL_ID, effort: env.MODEL_EFFORT })
}
