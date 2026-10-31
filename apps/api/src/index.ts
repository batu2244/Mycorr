import { Hono } from "hono"
import { cors } from "hono/cors"
import { serveStatic } from "hono/bun"
import { actors } from "@mycorr/actors/client"
import { createTripInputSchema, onboardingMessageInputSchema, newId } from "@mycorr/contracts"
import { loadEnv } from "@mycorr/integrations/config"
import { processUser, startRunIfReady } from "./demo-coordinator.js"
import { renderTranscriptText } from "./transcript-text.js"

const env = loadEnv()
const app = new Hono()
app.use("/api/*", cors())

type Vars = { userId: string }
const api = new Hono<{ Variables: Vars }>()

/**
 * DEVELOPMENT-ONLY identity: the caller names a seeded demo user with `x-mycorr-user`.
 * A real deployment replaces this middleware with a server session. Membership is still
 * enforced per trip below, so one demo user cannot read another's onboarding.
 */
api.use("*", async (c, next) => {
  const userId = c.req.header("x-mycorr-user")
  if (!userId || !/^[A-Za-z0-9._-]{1,128}$/.test(userId)) return c.json({ error: { code: "unauthenticated", message: "set x-mycorr-user (development identity)" } }, 401)
  c.set("userId", userId)
  await next()
})

const requireParticipant = async (tripId: string, userId: string) => {
  const trip = actors.TripActor.get(tripId)
  if (!(await trip.exists())) return { error: { code: "not_found", message: "trip not found" }, status: 404 as const }
  if (!(await trip.isParticipant(userId))) return { error: { code: "forbidden", message: "not a participant of this trip" }, status: 403 as const }
  return { trip }
}

api.post("/trips", async (c) => {
  const parsed = createTripInputSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: { code: "invalid_input", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } }, 400)
  const creatorId = c.get("userId")
  const input = parsed.data
  const participantIds = Array.from(new Set([creatorId, ...input.participantIds]))
  const tripId = newId("trip")
  const trip = actors.TripActor.get(tripId)
  await trip.create({ tripId, title: input.title, city: input.city, dateRange: input.dateRange, timezone: input.timezone, context: input.context, creatorId, participantIds })
  await actors.RegistryActor.get("global").registerTrip(tripId, participantIds)
  const summary = { tripId, title: input.title, city: input.city, dateRange: input.dateRange, timezone: input.timezone, context: input.context }
  await Promise.all(participantIds.map((u) => actors.UserActor.get(u).startOnboarding(summary)))
  return c.json(await trip.get(), 201)
})

api.get("/trips/:tripId", async (c) => {
  const r = await requireParticipant(c.req.param("tripId"), c.get("userId"))
  if ("error" in r) return c.json({ error: r.error }, r.status)
  return c.json(await r.trip.get())
})

api.post("/trips/:tripId/onboarding/messages", async (c) => {
  const tripId = c.req.param("tripId")
  const userId = c.get("userId")
  const r = await requireParticipant(tripId, userId)
  if ("error" in r) return c.json({ error: r.error }, r.status)
  const parsed = onboardingMessageInputSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: { code: "invalid_input", message: parsed.error.message } }, 400)
  const accepted = await actors.UserActor.get(userId).submitUserMessage(tripId, parsed.data.clientMessageId, parsed.data.text)
  // Demo slice: the in-process coordinator picks the task up right away. Still async: 202.
  void processUser(userId).catch((e) => console.error("[api] processUser failed", e))
  return c.json(accepted, 202)
})

api.get("/trips/:tripId/onboarding", async (c) => {
  const tripId = c.req.param("tripId")
  const userId = c.get("userId")
  const r = await requireParticipant(tripId, userId)
  if ("error" in r) return c.json({ error: r.error }, r.status)
  const state = await actors.UserActor.get(userId).getOnboarding(tripId)
  if (!state) return c.json({ error: { code: "not_found", message: "no onboarding session" } }, 404)
  return c.json(state)
})

api.post("/trips/:tripId/runs", async (c) => {
  const tripId = c.req.param("tripId")
  const r = await requireParticipant(tripId, c.get("userId"))
  if ("error" in r) return c.json({ error: r.error }, r.status)
  const view = (await r.trip.get())!
  if (view.activeRunId) return c.json({ error: { code: "run_active", message: `run ${view.activeRunId} is already active` } }, 409)
  if (!view.readiness.every((p) => p.ready)) return c.json({ error: { code: "not_ready", message: "not all participants are ready" } }, 409)
  const runId = await startRunIfReady(tripId)
  if (!runId) return c.json({ error: { code: "not_ready", message: "could not queue a run" } }, 409)
  return c.json({ runId }, 202)
})

api.get("/trips/:tripId/runs/:runId", async (c) => {
  const { tripId, runId } = c.req.param()
  const r = await requireParticipant(tripId, c.get("userId"))
  if ("error" in r) return c.json({ error: r.error }, r.status)
  const run = await r.trip.getRun(runId)
  if (!run) return c.json({ error: { code: "not_found", message: "run not found" } }, 404)
  return c.json({ run, transcript: await r.trip.getTranscript(runId) })
})

api.get("/trips/:tripId/runs/:runId/transcript", async (c) => {
  const { tripId, runId } = c.req.param()
  const r = await requireParticipant(tripId, c.get("userId"))
  if ("error" in r) return c.json({ error: r.error }, r.status)
  const run = await r.trip.getRun(runId)
  if (!run) return c.json({ error: { code: "not_found", message: "run not found" } }, 404)
  const transcript = await r.trip.getTranscript(runId)
  if (c.req.query("format") === "txt") {
    const view = (await r.trip.get())!
    return c.body(renderTranscriptText(run, transcript, view.trip.title), 200, { "Content-Type": "text/plain; charset=utf-8" })
  }
  return c.json({ runId, captureStatus: run.captureStatus, transcript })
})

app.route("/api", api)
app.get("/health", (c) => c.json({ ok: true, mode: env.MYCORR_MODE }))
app.use("/*", serveStatic({ root: "./public" }))

console.log(`[api] mode=${env.MYCORR_MODE} listening on http://127.0.0.1:${env.API_PORT}`)
export default { port: env.API_PORT, fetch: app.fetch }
