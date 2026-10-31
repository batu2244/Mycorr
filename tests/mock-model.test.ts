import { describe, expect, test } from "bun:test"
import { mockQuestionTurn } from "@mycorr/integrations/model"
import type { QuestionAgentContext } from "@mycorr/contracts"

const base = (text: string, missing: QuestionAgentContext["missingFields"] = ["availability", "flexibility", "dailyBudget", "totalBudget", "preferences"]): QuestionAgentContext => ({
  task: { taskId: "t1", userId: "u1", tripId: "trip1", sessionId: "s1", status: "claimed", attempts: 1, inputVersion: 1, createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z" },
  session: { sessionId: "s1", tripId: "trip1", userId: "u1", status: "active", inputVersion: 1, missingFields: missing, createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z" },
  trip: { tripId: "trip1", title: "Lisbon", city: "Lisbon", dateRange: { start: "2026-11-20", end: "2026-11-22" }, timezone: "Europe/Lisbon" },
  requirements: { schemaVersion: 1, profileVersion: 0, fields: {} },
  missingFields: missing,
  messages: [{ id: "m1", sessionId: "s1", tripId: "trip1", role: "user", text, createdAt: "2026-10-31T00:00:00.000Z", sequence: 0, inputVersion: 1 }],
  unprocessedMessageIds: ["m1"],
})

describe("mock question agent (deterministic rules)", () => {
  test("one answer fills several fields and an ambiguous budget triggers a clarification", () => {
    const out = mockQuestionTurn(base("I'm free Saturday afternoon, like hiking, and want to spend under $100"))
    expect(out.patch.fields.availability?.status).toBe("answered")
    expect((out.patch.fields.availability?.value as { kind: string }).kind).toBe("windows")
    expect(out.patch.fields.preferences?.status).toBe("answered")
    expect(out.patch.fields.dailyBudget?.status).toBe("needs_clarification")
    expect(out.next.kind).toBe("question")
    expect(out.next.kind === "question" && out.next.text).toMatch(/daily|total/i)
  })

  test("a fully specified budget is answered with currency, scope and firmness", () => {
    const out = mockQuestionTurn(base("Roughly €100 per day all-in, and no total limit."))
    expect(out.patch.fields.dailyBudget).toEqual({
      status: "answered",
      value: { kind: "amount", amountMinor: 10000, currency: "EUR", scope: "all", firmness: "flexible" },
    })
    expect(out.patch.fields.totalBudget).toEqual({ status: "answered", value: { kind: "no_limit" } })
  })

  test("completion is only claimed when nothing is missing", () => {
    const out = mockQuestionTurn(base("Flexible on schedule and spending, fixed: no bars.", ["flexibility"]))
    expect(out.patch.fields.flexibility?.status).toBe("answered")
    expect(out.next.kind).toBe("complete")
  })
})
