import { describe, expect, test } from "bun:test"
import { checkConstraints } from "../apps/api/src/demo-coordinator.js"
import type { Itinerary } from "@mycorr/contracts"

const item = (title: string, startTime: string, endTime: string) => ({ day: "2026-11-21", startTime, endTime, title, category: "food", estimatedCostMinor: 2000, currency: "EUR", costLabel: "unverified estimate" as const })

describe("itinerary schedule check", () => {
  test("overlapping items on one day are reported as violated", () => {
    const itinerary: Itinerary = { assembledByUserId: "ana", sourceProposalIds: [], days: [{ date: "2026-11-21", items: [item("Chiado lunch", "12:30", "14:00"), item("Market lunch", "12:45", "14:15")] }] }
    const report = checkConstraints([], itinerary)
    expect(report.some((r) => r.check.startsWith("schedule overlap") && r.outcome === "violated")).toBe(true)
  })
  test("back-to-back items are fine", () => {
    const itinerary: Itinerary = { assembledByUserId: "ana", sourceProposalIds: [], days: [{ date: "2026-11-21", items: [item("Lunch", "12:30", "14:00"), item("Walk", "14:00", "16:00")] }] }
    expect(checkConstraints([], itinerary).filter((r) => r.outcome === "violated")).toEqual([])
  })
})
