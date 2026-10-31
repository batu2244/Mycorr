/**
 * DEMO-ONLY in-process coordinator. The full design runs this in apps/worker inside
 * the Superserve sandbox; for the demo it runs inside the API process so the flow
 * completes end to end. Persistence is still the real Durable Actors runtime.
 */
import { actors } from "@mycorr/actors/client"
import {
  COST_LABEL,
  personalAgentTurnOutputSchema,
  questionAgentOutputSchema,
  type PersonalTurnContext,
  type Proposal,
  type Evaluation,
  type RunParticipantSnapshot,
  type RunResult,
  type TranscriptCapture,
} from "@mycorr/contracts"
import { loadEnv } from "@mycorr/integrations/config"
import { createModelProvider, type ModelProvider } from "@mycorr/integrations/model"
import { MockRelay } from "@mycorr/integrations/relay"

const env = loadEnv()
const model: ModelProvider = createModelProvider(env)
const relay = new MockRelay()
const WORKER = `api-demo-${process.pid}`
const inflight = new Set<string>()

export const QUESTION_SYSTEM = `You are a friendly trip-planning onboarding assistant. Extract structured profile fields from the user's latest answers, ask ONE focused follow-up question for the most important missing or ambiguous field, never invent values, never guess currency/scope/timezone, and mark ambiguous answers needs_clarification. Respond with JSON matching the schema.`
export const PERSONAL_SYSTEM = `You are a personal planning agent representing one traveller in a group discussion. Plan only inside the fixed city and date range. Respect the traveller's hard constraints. Label every cost as an unverified estimate. Respond with JSON matching the schema.`

/** Processes every pending question task for a user, then delivers readiness events. Safe to call repeatedly. */
export async function processUser(userId: string): Promise<void> {
  if (inflight.has(userId)) return
  inflight.add(userId)
  try {
    const user = actors.UserActor.get(userId)
    for (let i = 0; i < 10; i++) {
      const ctx = await user.claimQuestionTask(WORKER, 60_000)
      if (!ctx) break
      const result = await model.complete({ system: QUESTION_SYSTEM, user: JSON.stringify(ctx), schema: questionAgentOutputSchema, schemaName: "question_agent_output" })
      if (!result.ok) {
        await user.failQuestionTask(ctx.task.taskId, result.error, result.retryable)
        if (!result.retryable) break
        continue
      }
      const out = result.value
      const completeText = out.next.kind === "complete" ? out.next.text : undefined
      await user.completeQuestionTask({
        taskId: ctx.task.taskId,
        inputVersion: ctx.task.inputVersion,
        patch: out.patch,
        assistantText: out.next.kind === "question" ? out.next.text : completeText,
        processedMessageIds: ctx.unprocessedMessageIds,
      })
    }
    await deliverOutbox(userId)
  } finally {
    inflight.delete(userId)
  }
}

async function deliverOutbox(userId: string): Promise<void> {
  const user = actors.UserActor.get(userId)
  const events = await user.pendingOutbox(20)
  for (const ev of events) {
    const trip = actors.TripActor.get(ev.payload.tripId)
    await user.markOutboxAttempt(ev.eventId)
    const outcome = await trip.participantReady(ev.payload)
    await user.markOutboxDelivered(ev.eventId)
    if (outcome.allReady) await startRunIfReady(ev.payload.tripId)
  }
}

export async function startRunIfReady(tripId: string): Promise<string | undefined> {
  const trip = actors.TripActor.get(tripId)
  const view = await trip.get()
  if (!view) return undefined
  const snapshots: RunParticipantSnapshot[] = []
  for (const userId of view.trip.participantIds) {
    const snap = await actors.UserActor.get(userId).getProfileSnapshot(tripId)
    if (!snap || !snap.ready) return undefined
    snapshots.push({ userId, profileVersion: snap.profileVersion, schemaVersion: snap.schemaVersion, requirements: snap.requirements })
  }
  const queued = await trip.queueRunIfReady(snapshots)
  if (!queued.runId) return undefined
  if (queued.reason === "queued") void runPlanning(tripId, queued.runId).catch((e) => console.error("[demo-coordinator] planning failed", e))
  return queued.runId
}

async function runPlanning(tripId: string, runId: string): Promise<void> {
  const trip = actors.TripActor.get(tripId)
  const task = await trip.claimPlanningTask(WORKER, 300_000)
  if (!task || task.runId !== runId || task.kind !== "start_run") return
  const view = (await trip.get())!
  let run = (await trip.getRun(runId))!
  const deadline = Date.now() + run.limits.deadlineMs
  let modelCalls = 0
  let totalTokens = 0

  // Relay workspace, agents, shared channel, recorder.
  const channelName = `trip-${tripId}-${runId.slice(-6)}`
  const channel = await relay.createChannel(channelName, `Planning ${view.trip.title}`)
  const agents = new Map<string, { agentName: string; apiToken: string }>()
  for (const p of run.participants) {
    const reg = await relay.registerAgent(`${p.userId}-${runId.slice(-6)}`)
    agents.set(p.userId, { agentName: reg.agentName, apiToken: reg.apiToken })
  }
  await trip.setRunCredentials(runId, [...agents.entries()].map(([userId, a]) => ({ userId, agentName: a.agentName, apiToken: a.apiToken })))
  const agentNames = Object.fromEntries([...agents.entries()].map(([u, a]) => [u, a.agentName]))
  run = await trip.startRun(runId, { workspaceRef: await relay.workspaceRef(), channelName: channel.channelName, channelId: channel.channelId }, agentNames)

  const byAgent = new Map([...agents.values()].map((a) => [a.agentName, a]))
  const pendingRecords: Promise<unknown>[] = []
  const unsubscribe = relay.subscribe(async (m) => {
    if (m.channelName !== channel.channelName) return
    const capture: TranscriptCapture = {
      relayMessageId: m.id, tripId, runId, senderAgentId: m.fromAgent,
      representedUserId: [...agents.entries()].find(([, a]) => a.agentName === m.fromAgent)?.[0],
      channelId: m.channelId, replyToMessageId: m.replyToMessageId, sentAt: m.createdAt, text: m.text,
    }
    pendingRecords.push(trip.recordTranscript(runId, [capture]))
  })
  const sessions = new Map<string, Awaited<ReturnType<typeof relay.connectAgent>>>()
  for (const [userId, a] of agents) {
    const s = await relay.connectAgent(a.apiToken)
    await s.join(channel.channelName)
    sessions.set(userId, s)
  }
  await trip.setCaptureStatus(runId, "partial")

  const history: { senderAgentId: string; text: string }[] = []
  const turn = async (userId: string, phase: PersonalTurnContext["phase"], round: number) => {
    if (Date.now() > deadline) throw new Error("run deadline exceeded")
    if (modelCalls >= run.limits.maxModelCalls) throw new Error("model call budget exceeded")
    const p = run.participants.find((x) => x.userId === userId)!
    const ctx: PersonalTurnContext = {
      phase, round, runId,
      trip: { tripId, title: view.trip.title, city: view.trip.city, dateRange: view.trip.dateRange, timezone: view.trip.timezone, context: view.trip.context },
      self: { userId, agentName: agentNames[userId]!, requirements: p.requirements },
      participants: run.participants.map((x) => ({ userId: x.userId, agentName: agentNames[x.userId]! })),
      proposals: await trip.listProposals(runId),
      evaluations: await trip.listEvaluations(runId),
      history,
    }
    const res = await model.complete({ system: PERSONAL_SYSTEM, user: JSON.stringify(ctx), schema: personalAgentTurnOutputSchema, schemaName: "personal_agent_turn" })
    modelCalls++
    totalTokens += res.usage.inputTokens + res.usage.outputTokens
    if (!res.ok) return undefined
    const out = res.value
    const now = new Date().toISOString()
    if (out.message) {
      await sessions.get(userId)!.send(channel.channelName, out.message, { metadata: { mycorr: { kind: "result", phase, round } } })
      history.push({ senderAgentId: agentNames[userId]!, text: out.message })
    }
    if (out.proposal) {
      const proposal: Proposal = { ...out.proposal, proposalId: `prop_${crypto.randomUUID().slice(0, 8)}`, byUserId: userId, round, createdAt: now, items: out.proposal.items.map((i) => ({ ...i, costLabel: COST_LABEL })) }
      await trip.recordProposal(runId, proposal)
    }
    for (const e of out.evaluations ?? []) {
      const evaluation: Evaluation = { ...e, byUserId: userId, round, createdAt: now }
      await trip.recordEvaluation(runId, evaluation)
    }
    return out
  }

  let result: RunResult | undefined
  const missing = new Set<string>()
  try {
    for (let round = 1; round <= run.limits.maxRounds; round++) {
      await trip.updateRunProgress(runId, { currentRound: round, modelCalls, totalTokens })
      const coordinatorToken = agents.values().next().value!.apiToken
      await relay.sendAs(coordinatorToken, channel.channelName, `Round ${round}: everyone, propose a plan for ${view.trip.city} (${view.trip.dateRange.start} to ${view.trip.dateRange.end}).`, { metadata: { mycorr: { kind: "task", phase: "propose", round } } })
      for (const userId of run.participants.map((p) => p.userId)) if (!(await turn(userId, "propose", round))) missing.add(userId)
      for (const userId of run.participants.map((p) => p.userId)) if (!(await turn(userId, "evaluate", round))) missing.add(userId)
      const assembler = run.participants[0]!.userId
      const assembled = await turn(assembler, "assemble", round)
      const evaluations = await trip.listEvaluations(runId)
      const rejected = evaluations.filter((e) => e.verdict === "reject" && e.round === round)
      if (assembled?.itinerary) {
        const itinerary = { ...assembled.itinerary, assembledByUserId: assembler }
        const constraintReport = checkConstraints(run.participants, itinerary)
        result = {
          summary: `${run.participants.length} agents exchanged ${(await trip.listProposals(runId)).length} proposals over ${round} round(s). ${rejected.length ? `${rejected.length} evaluation(s) rejected a proposal.` : "No proposal was rejected."} Draft itinerary assembled by ${agentNames[assembler]}.`,
          itinerary,
          conflicts: assembled.conflicts ?? [],
          constraintReport,
        }
        if (rejected.length === 0 && constraintReport.every((c) => c.outcome !== "violated")) break
      }
    }
    await Promise.allSettled(pendingRecords)
    unsubscribe()
    for (const s of sessions.values()) await s.close()
    // Reconcile captured transcript against relay history before marking capture complete.
    const historyMsgs = await relay.listMessages(channel.channelName)
    const captured = await trip.getTranscript(runId)
    const have = new Set(captured.map((m) => m.relayMessageId))
    const gaps = historyMsgs.filter((m) => !have.has(m.id))
    if (gaps.length) await trip.recordTranscript(runId, gaps.map((m) => ({ relayMessageId: m.id, tripId, runId, senderAgentId: m.fromAgent, representedUserId: [...agents.entries()].find(([, a]) => a.agentName === m.fromAgent)?.[0], channelId: m.channelId, sentAt: m.createdAt, text: m.text })))
    await trip.setCaptureStatus(runId, "complete")
    await trip.updateRunProgress(runId, { modelCalls, totalTokens, missingResponses: [...missing] })
    if (!result) await trip.finishRun(runId, "needs_input", undefined, "agents did not produce a draft within the configured limits")
    else if (result.conflicts.length || result.constraintReport.some((c) => c.outcome === "violated") || missing.size) await trip.finishRun(runId, "needs_input", result)
    else await trip.finishRun(runId, "completed", result)
    await trip.completePlanningTask(task.taskId)
  } catch (error) {
    unsubscribe()
    for (const s of sessions.values()) await s.close()
    await trip.updateRunProgress(runId, { modelCalls, totalTokens, missingResponses: [...missing] })
    await trip.finishRun(runId, "failed", result, error instanceof Error ? error.message : String(error))
    await trip.failPlanningTask(task.taskId, error instanceof Error ? error.message : String(error), false)
  }
}

/** Backend-side check of supported hard constraints (daily budget, dislikes). Unknown costs are reported as unverified. */
function checkConstraints(participants: RunParticipantSnapshot[], itinerary: RunResult["itinerary"] & object): RunResult["constraintReport"] {
  const report: RunResult["constraintReport"] = []
  for (const p of participants) {
    const daily = p.requirements.fields.dailyBudget?.value as { kind: string; amountMinor?: number; currency?: string } | undefined
    const prefs = p.requirements.fields.preferences?.value as { kind: string; dislikes?: { category: string }[] } | undefined
    for (const day of itinerary.days) {
      if (daily?.kind === "amount") {
        if (day.items.some((i) => i.estimatedCostMinor === undefined)) report.push({ userId: p.userId, check: `daily budget ${day.date}`, outcome: "unverified", detail: "some items have no cost estimate" })
        else {
          const spend = day.items.reduce((s, i) => s + (i.estimatedCostMinor ?? 0), 0)
          report.push({ userId: p.userId, check: `daily budget ${day.date}`, outcome: spend <= daily.amountMinor! ? "ok" : "violated", detail: `${spend / 100} vs ${daily.amountMinor! / 100} ${daily.currency}` })
        }
      }
      for (const item of day.items) if (prefs?.kind === "stated" && prefs.dislikes?.some((d) => d.category === item.category)) report.push({ userId: p.userId, check: `dislike ${item.category}`, outcome: "violated", detail: item.title })
    }
  }
  return report
}
