/**
 * Integration tests against the real local Durable Actors runtime.
 * Requires `bun run actors:dev` to be listening on http://127.0.0.1:7100.
 */
import { describe, expect, test } from "bun:test"
import { actors } from "@mycorr/actors/client"
import type { RunParticipantSnapshot, TripRequirements } from "@mycorr/contracts"

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`
const trip = (tripId: string) => ({
  tripId,
  title: "Lisbon weekend",
  city: "Lisbon",
  dateRange: { start: "2026-11-20", end: "2026-11-22" },
  timezone: "Europe/Lisbon",
})

const completeFields = (ids: string[]) => ({
  availability: { status: "answered" as const, value: { kind: "whole_range" } },
  flexibility: { status: "answered" as const, value: { negotiable: ["schedule"], fixed: [] } },
  dailyBudget: { status: "answered" as const, value: { kind: "amount", amountMinor: 10000, currency: "EUR", scope: "all", firmness: "flexible" } },
  totalBudget: { status: "answered" as const, value: { kind: "no_limit" } },
  preferences: { status: "answered" as const, value: { kind: "stated", interests: [{ category: "food" }], dislikes: [], priorities: [] } },
})

describe("UserActor onboarding", () => {
  test("persists raw answers, dedupes clientMessageId, and isolates users", async () => {
    const tripId = uid("trip")
    const [a, b] = [actors.UserActor.get(uid("ana")), actors.UserActor.get(uid("ben"))]
    await Promise.all([a.startOnboarding(trip(tripId)), b.startOnboarding(trip(tripId))])

    const [ra, rb] = await Promise.all([
      a.submitUserMessage(tripId, "c1", "I'm free the whole weekend"),
      b.submitUserMessage(tripId, "c1", "Only Saturday for me"),
    ])
    expect(ra.deduplicated).toBe(false)
    expect(rb.deduplicated).toBe(false)
    expect(ra.messageId).not.toBe(rb.messageId)

    const again = await a.submitUserMessage(tripId, "c1", "I'm free the whole weekend")
    expect(again.deduplicated).toBe(true)
    expect(again.messageId).toBe(ra.messageId)

    const [sa, sb] = await Promise.all([a.getOnboarding(tripId), b.getOnboarding(tripId)])
    expect(sa!.messages.map((m) => m.text)).toEqual(["I'm free the whole weekend"])
    expect(sb!.messages.map((m) => m.text)).toEqual(["Only Saturday for me"])
    expect(sa!.pendingTask?.status).toBe("pending")
  })

  test("schema rules decide readiness; malformed values are rejected", async () => {
    const tripId = uid("trip")
    const u = actors.UserActor.get(uid("cat"))
    await u.startOnboarding(trip(tripId))
    await u.submitUserMessage(tripId, "m1", "Whole weekend, €100/day, love food")

    const ctx = await u.claimQuestionTask("worker-1", 30_000)
    expect(ctx).not.toBeNull()
    expect(ctx!.unprocessedMessageIds.length).toBe(1)

    // Model claims a budget without currency/scope: must be rejected, not invented.
    const partial = await u.completeQuestionTask({
      taskId: ctx!.task.taskId,
      inputVersion: ctx!.task.inputVersion,
      patch: {
        fields: {
          availability: { status: "answered", value: { kind: "whole_range" } },
          dailyBudget: { status: "answered", value: { kind: "amount", amountMinor: 10000 } },
        },
      },
      assistantText: "Is €100 a daily or a total budget, and does it include lodging?",
      processedMessageIds: ctx!.unprocessedMessageIds,
    })
    expect(partial.outcome).toBe("applied")
    if (partial.outcome !== "applied") throw new Error("unreachable")
    expect(partial.ready).toBe(false)
    expect(partial.rejectedFields.length).toBe(1)
    expect(partial.missingFields).toContain("dailyBudget")

    const state = await u.getOnboarding(tripId)
    expect(state!.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(state!.requirements.fields.availability?.status).toBe("answered")
    expect(state!.requirements.fields.availability?.supportingAnswerIds).toEqual(ctx!.unprocessedMessageIds)
    expect(state!.session.status).toBe("active")

    // Second answer completes everything -> ready, with a readiness event in the outbox.
    await u.submitUserMessage(tripId, "m2", "Daily, all-in, flexible. No total limit.")
    const ctx2 = await u.claimQuestionTask("worker-1", 30_000)
    const done = await u.completeQuestionTask({
      taskId: ctx2!.task.taskId,
      inputVersion: ctx2!.task.inputVersion,
      patch: { fields: completeFields([]) },
      processedMessageIds: ctx2!.unprocessedMessageIds,
    })
    expect(done.outcome).toBe("applied")
    if (done.outcome !== "applied") throw new Error("unreachable")
    expect(done.ready).toBe(true)
    const outbox = await u.pendingOutbox(10)
    expect(outbox.at(-1)?.payload.ready).toBe(true)
    expect(outbox.at(-1)?.payload.profileVersion).toBe(done.profileVersion)
    const snap = await u.getProfileSnapshot(tripId)
    expect(snap!.ready).toBe(true)
    expect(Object.keys(snap!)).not.toContain("messages")
  })

  test("a fast follow-up message makes the in-flight result stale instead of publishing it", async () => {
    const tripId = uid("trip")
    const u = actors.UserActor.get(uid("dan"))
    await u.startOnboarding(trip(tripId))
    await u.submitUserMessage(tripId, "m1", "Budget is 100")
    const ctx = await u.claimQuestionTask("worker-1", 30_000)
    // User clarifies while the model is still running.
    await u.submitUserMessage(tripId, "m2", "Sorry, I meant 100 euro per day total")
    const result = await u.completeQuestionTask({
      taskId: ctx!.task.taskId,
      inputVersion: ctx!.task.inputVersion,
      patch: { fields: {} },
      assistantText: "Is that daily or total?",
      processedMessageIds: ctx!.unprocessedMessageIds,
    })
    expect(result.outcome).toBe("stale")
    const state = await u.getOnboarding(tripId)
    // The obsolete question was never published; a fresh task targets the newer input.
    expect(state!.messages.filter((m) => m.role === "assistant").length).toBe(0)
    expect(state!.pendingTask?.status).toBe("pending")
    expect(state!.pendingTask?.inputVersion).toBe(2)
  })
})

describe("TripActor runs", () => {
  const snapshot = (userId: string, profileVersion: number): RunParticipantSnapshot => ({
    userId,
    profileVersion,
    schemaVersion: 1,
    requirements: { schemaVersion: 1, profileVersion, fields: {} } as TripRequirements,
  })

  test("starts exactly one run when the last participant becomes ready; duplicates are ignored", async () => {
    const tripId = uid("trip")
    const t = actors.TripActor.get(tripId)
    const [u1, u2, u3] = [uid("u1"), uid("u2"), uid("u3")]
    await t.create({ ...trip(tripId), creatorId: u1, participantIds: [u1, u2, u3] })

    const n = (userId: string, eventId: string, ready = true, profileVersion = 1) => ({
      eventId, userId, tripId, ready, profileVersion, schemaVersion: 1, occurredAt: new Date().toISOString(),
    })
    const r1 = await t.participantReady(n(u1, "e1"))
    expect(r1.allReady).toBe(false)
    const r2 = await t.participantReady(n(u2, "e2"))
    expect(r2.allReady).toBe(false)
    const r3 = await t.participantReady(n(u3, "e3"))
    expect(r3.allReady).toBe(true)

    const q1 = await t.queueRunIfReady([snapshot(u1, 1), snapshot(u2, 1), snapshot(u3, 1)])
    expect(q1.runId).toBeDefined()
    const q2 = await t.queueRunIfReady([snapshot(u1, 1), snapshot(u2, 1), snapshot(u3, 1)])
    expect(q2.runId).toBe(q1.runId)

    const dup = await t.participantReady(n(u3, "e3"))
    expect(dup.duplicate).toBe(true)

    const view = await t.get()
    expect(view!.activeRunId).toBe(q1.runId)
    expect(view!.runIds).toEqual([q1.runId!])

    const task = await t.claimPlanningTask("worker-1", 30_000)
    expect(task?.kind).toBe("start_run")
    expect(task?.runId).toBe(q1.runId)
  })

  test("a profile change during an active run marks it stale", async () => {
    const tripId = uid("trip")
    const t = actors.TripActor.get(tripId)
    const [u1, u2] = [uid("u1"), uid("u2")]
    await t.create({ ...trip(tripId), creatorId: u1, participantIds: [u1, u2] })
    const n = (userId: string, eventId: string, profileVersion: number) => ({
      eventId, userId, tripId, ready: true, profileVersion, schemaVersion: 1, occurredAt: new Date().toISOString(),
    })
    await t.participantReady(n(u1, "e1", 1))
    await t.participantReady(n(u2, "e2", 1))
    const { runId } = await t.queueRunIfReady([snapshot(u1, 1), snapshot(u2, 1)])
    await t.startRun(runId!, { channelName: "trip-x" }, { [u1]: "agent-u1", [u2]: "agent-u2" })

    const change = await t.participantReady(n(u2, "e3", 2))
    expect(change.staleRunId).toBe(runId)
    const run = await t.getRun(runId!)
    expect(run!.status).toBe("stale")
    expect((await t.get())!.activeRunId).toBeUndefined()

    // A replacement run can now be queued for the new input revision.
    const next = await t.queueRunIfReady([snapshot(u1, 1), snapshot(u2, 2)])
    expect(next.runId).toBeDefined()
    expect(next.runId).not.toBe(runId)
  })

  test("transcript capture is append-only and deduplicated on relayMessageId", async () => {
    const tripId = uid("trip")
    const t = actors.TripActor.get(tripId)
    const u1 = uid("u1")
    await t.create({ ...trip(tripId), creatorId: u1, participantIds: [u1] })
    await t.participantReady({ eventId: "e1", userId: u1, tripId, ready: true, profileVersion: 1, schemaVersion: 1, occurredAt: new Date().toISOString() })
    const { runId } = await t.queueRunIfReady([snapshot(u1, 1)])
    const cap = (relayMessageId: string, text: string) => ({
      relayMessageId, tripId, runId: runId!, senderAgentId: "agent-u1", representedUserId: u1, channelId: "ch1", sentAt: new Date().toISOString(), text,
    })
    const first = await t.recordTranscript(runId!, [cap("r1", "hello"), cap("r2", "world")])
    expect(first).toEqual({ inserted: 2, duplicates: 0, nextSequence: 2 })
    const retry = await t.recordTranscript(runId!, [cap("r2", "world"), cap("r3", "again")])
    expect(retry).toEqual({ inserted: 1, duplicates: 1, nextSequence: 3 })
    const transcript = await t.getTranscript(runId!)
    expect(transcript.map((m) => [m.sequence, m.text])).toEqual([[0, "hello"], [1, "world"], [2, "again"]])
  })
})
