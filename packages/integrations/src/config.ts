import { z } from "zod"

/**
 * Single place that reads process.env. Every variable here appears in .env.example.
 * MODE=mock swaps external services for deterministic adapters; persistence still
 * uses the real local Durable Actors runtime.
 */
const envSchema = z.object({
  MYCORR_MODE: z.enum(["mock", "integrated"]).default("mock"),

  // Actor runtime (generated client reads these itself; listed for .env completeness)
  DURABLE_ACTORS_CONTROL_PLANE_URL: z.string().url().default("http://127.0.0.1:7100"),
  DURABLE_ACTORS_PROJECT_ID: z.string().default("local"),
  DURABLE_ACTORS_SECRET: z.string().optional(),

  // API process
  API_PORT: z.coerce.number().int().positive().default(3000),
  /** URL that agent VMs use to reach this backend (Superserve preview URL in integrated mode). */
  PUBLIC_BACKEND_URL: z.string().url().default("http://127.0.0.1:3000"),
  /** HMAC key for minting scoped agent tokens and verifying them. */
  AGENT_TOKEN_SECRET: z.string().min(16).default("dev-only-agent-token-secret-change-me"),
  /** Shared secret the coordinator uses for service-to-service calls to the API. */
  SERVICE_TOKEN: z.string().min(8).default("dev-only-service-token"),

  // Model
  MODEL_PROVIDER: z.enum(["openai", "mock"]).optional(),
  OPENAI_API_KEY: z.string().optional(),
  /** Optional override, for example an Azure OpenAI or proxy endpoint. */
  OPENAI_BASE_URL: z.string().url().optional(),
  MODEL_ID: z.string().default("gpt-6.1-sol"),
  MODEL_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),

  // Superserve
  SUPERSERVE_API_KEY: z.string().optional(),
  SUPERSERVE_BASE_URL: z.string().url().optional(),
  /** Sandbox that hosts the backend (API + worker + actor runtime) and publishes API_PORT. */
  SUPERSERVE_SANDBOX_ID: z.string().optional(),
  /** Private preview-port token agents send to reach PUBLIC_BACKEND_URL. */
  SUPERSERVE_PREVIEW_TOKEN: z.string().optional(),
  SUPERSERVE_PREVIEW_HEADER: z.string().default("X-Superserve-Preview-Token"),
  /** Template used for agent VMs. */
  SUPERSERVE_AGENT_TEMPLATE: z.string().default("superserve/base"),

  // Relay
  RELAY_WORKSPACE_KEY: z.string().optional(),
  RELAY_BASE_URL: z.string().url().optional(),

  // Worker
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_LEASE_MS: z.coerce.number().int().positive().default(120_000),

  // Optional webhook
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")
    throw new Error(`Invalid environment:\n  ${issues}`)
  }
  const env = parsed.data
  if (source === process.env) cached = env
  return env
}

export function isIntegrated(env: Env): boolean {
  return env.MYCORR_MODE === "integrated"
}

/** Which provider to use for the model, resolved from mode and credentials. Never silently downgrades. */
export function modelProviderFor(env: Env): "openai" | "mock" {
  if (env.MODEL_PROVIDER) return env.MODEL_PROVIDER
  return isIntegrated(env) ? "openai" : "mock"
}

/** Lists the integrated-mode prerequisites that are missing, so callers can refuse loudly. */
export function missingIntegratedConfig(env: Env): string[] {
  const missing: string[] = []
  if (!env.OPENAI_API_KEY && modelProviderFor(env) === "openai") missing.push("OPENAI_API_KEY")
  if (!env.SUPERSERVE_API_KEY) missing.push("SUPERSERVE_API_KEY")
  if (!env.SUPERSERVE_SANDBOX_ID) missing.push("SUPERSERVE_SANDBOX_ID")
  if (!env.SUPERSERVE_PREVIEW_TOKEN) missing.push("SUPERSERVE_PREVIEW_TOKEN")
  if (!env.RELAY_WORKSPACE_KEY) missing.push("RELAY_WORKSPACE_KEY")
  return missing
}
