import { describe, expect, test } from "bun:test"
import {
  FIELD_KEYS,
  ONBOARDING_REQUIRED_KEYS,
  PROFILE_SCHEMA_VERSION,
  computeMissingFields,
  validateFieldValue,
  type TripRequirements,
} from "@mycorr/contracts"

const now = "2026-10-31T12:00:00.000Z"
const answered = (value: unknown) => ({ status: "answered" as const, value, supportingAnswerIds: ["m1"], updatedAt: now })

describe("profile completeness", () => {
  test("empty requirements are entirely missing", () => {
    const req: TripRequirements = { schemaVersion: PROFILE_SCHEMA_VERSION, profileVersion: 0, fields: {} }
    expect(computeMissingFields(req, FIELD_KEYS)).toEqual(["availability", "flexibility", "dailyBudget", "totalBudget", "preferences"])
  })

  test("onboarding currently requires only restaurant preferences", () => {
    const req: TripRequirements = { schemaVersion: PROFILE_SCHEMA_VERSION, profileVersion: 0, fields: {} }
    expect(ONBOARDING_REQUIRED_KEYS).toEqual(["preferences"])
    expect(computeMissingFields(req)).toEqual(["preferences"])
    const withPrefs: TripRequirements = {
      ...req,
      fields: { preferences: answered({ kind: "stated", interests: [{ category: "restaurants", detail: "sushi, ramen" }], dislikes: [], priorities: [] }) },
    }
    expect(computeMissingFields(withPrefs)).toEqual([])
  })

  test("a complete, valid profile has no missing fields", () => {
    const req: TripRequirements = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profileVersion: 3,
      fields: {
        availability: answered({ kind: "whole_range" }),
        flexibility: answered({ negotiable: ["schedule"], fixed: ["no bars"] }),
        dailyBudget: answered({ kind: "amount", amountMinor: 10000, currency: "USD", scope: "all", firmness: "firm" }),
        totalBudget: answered({ kind: "no_limit" }),
        preferences: answered({ kind: "stated", interests: [{ category: "nature" }], dislikes: [], priorities: [] }),
      },
    }
    expect(computeMissingFields(req)).toEqual([])
  })

  test("an 'answered' status with a malformed value does not count as complete", () => {
    const req: TripRequirements = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profileVersion: 1,
      fields: { dailyBudget: answered({ kind: "amount", amountMinor: "100" }) },
    }
    expect(computeMissingFields(req, FIELD_KEYS)).toContain("dailyBudget")
  })

  test("needs_clarification is not complete", () => {
    const req: TripRequirements = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profileVersion: 1,
      fields: {
        dailyBudget: { status: "needs_clarification", note: "daily or total?", supportingAnswerIds: ["m1"], updatedAt: now },
      },
    }
    expect(computeMissingFields(req, FIELD_KEYS)).toContain("dailyBudget")
  })

  test("budget scope and currency are never defaulted", () => {
    expect(validateFieldValue("dailyBudget", { kind: "amount", amountMinor: 10000 }).ok).toBe(false)
    expect(validateFieldValue("dailyBudget", { kind: "amount", amountMinor: 10000, currency: "USD", scope: "all", firmness: "firm" }).ok).toBe(true)
  })
})
