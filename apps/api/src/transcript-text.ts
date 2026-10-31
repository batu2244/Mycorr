import type { PlanningRun, TranscriptMessage } from "@mycorr/contracts"

/** Plain-text export of a saved run: transcript first, then result sections, kept separate. */
export function renderTranscriptText(run: PlanningRun, transcript: TranscriptMessage[], tripTitle: string): string {
  const lines: string[] = []
  lines.push(`Mycorr planning run ${run.runId}`)
  lines.push(`Trip: ${tripTitle}`)
  lines.push(`Status: ${run.status}  Capture: ${run.captureStatus}  Rounds: ${run.currentRound}/${run.limits.maxRounds}`)
  lines.push(`Started: ${run.startedAt ?? "-"}  Finished: ${run.finishedAt ?? "-"}`)
  lines.push("")
  lines.push("=== Conversation (capture order) ===")
  for (const m of transcript) {
    const who = m.representedUserId ? `${m.senderAgentId} (for ${m.representedUserId})` : m.senderAgentId
    lines.push(`[${m.sequence}] ${m.sentAt} ${who}:`)
    lines.push(`    ${m.text.replace(/\n/g, "\n    ")}`)
  }
  if (transcript.length === 0) lines.push("(no messages captured)")
  lines.push("")
  lines.push("=== Summary ===")
  lines.push(run.result?.summary ?? "(no summary)")
  lines.push("")
  lines.push("=== Draft itinerary (costs are unverified estimates) ===")
  if (run.result?.itinerary) {
    for (const day of run.result.itinerary.days) {
      lines.push(day.date)
      for (const item of day.items) {
        const cost = item.estimatedCostMinor !== undefined ? ` ~${(item.estimatedCostMinor / 100).toFixed(0)} ${item.currency ?? ""} (${item.costLabel})` : ""
        lines.push(`  ${item.startTime ?? "--:--"}-${item.endTime ?? "--:--"} ${item.title} [${item.category}]${cost}`)
      }
    }
  } else lines.push("(no draft itinerary)")
  lines.push("")
  lines.push("=== Unresolved conflicts ===")
  if (run.result?.conflicts.length) for (const c of run.result.conflicts) lines.push(`- ${c.topic}: ${c.description} (${c.participantIds.join(", ")})`)
  else lines.push("(none)")
  if (run.missingResponses.length) {
    lines.push("")
    lines.push(`=== Missing responses (not agreement) ===\n${run.missingResponses.join(", ")}`)
  }
  if (run.failure) lines.push("", `=== Failure ===\n${run.failure}`)
  return lines.join("\n") + "\n"
}
