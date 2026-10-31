/**
 * Smoke test over HTTP: creates a trip with N demo users, onboards each with one or two
 * messages, waits for the automatic run, prints the result and the text export.
 * Usage: bun run scripts/smoke.ts [participantCount=2] [baseUrl=http://127.0.0.1:3000]
 */
const count = Number(process.argv[2] ?? 2)
const base = process.argv[3] ?? "http://127.0.0.1:3000"
const users = ["ana", "ben", "cat", "dan", "eve", "fay", "gus", "hal"].slice(0, count)
const answers: Record<string, string[]> = {
  ana: ["I am free the whole weekend. Roughly €100 per day all-in, and no total limit. I love food and museums, no bars. Totally flexible."],
  ben: ["Only Saturday afternoon for me. Budget is 80 euros.", "Daily, around 80 euros per day all-in, flexible. No total limit either. I like nature and bars. Flexible on schedule, fixed: no museums."],
  cat: ["Whole weekend works. About €120 per day excluding hotel, firm. No total limit. Into restaurants and nature. Flexible on activities, fixed: schedule."],
  dan: ["Free Friday evening and Saturday. Around $90 per day all-in, flexible, no total limit. Museums and food please. Totally flexible."],
  eve: ["Entire range works. €70 per day all-in, firm. In total €200 all-in, firm. Nature and food. Flexible on everything."],
  fay: ["Whole weekend. No limit at all on budget. Bars and restaurants. Totally flexible."],
  gus: ["Saturday only. €60 per day all-in, flexible, no total limit. Nature. Flexible on everything."],
  hal: ["Whole weekend. €150 per day all-in, flexible, no total limit. Museums and restaurants. Totally flexible."],
}
const call = async (path: string, user: string, init?: RequestInit) => {
  const r = await fetch(`${base}/api${path}`, { ...init, headers: { "content-type": "application/json", "x-mycorr-user": user, ...(init?.headers ?? {}) } })
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`)
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text()
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const view = await call("/trips", users[0]!, { method: "POST", body: JSON.stringify({ title: `Lisbon x${count}`, city: "Lisbon", dateRange: { start: "2026-11-20", end: "2026-11-22" }, participantIds: users.slice(1) }) })
const tripId = view.trip.tripId as string
console.log(`trip ${tripId} participants=${users.join(",")}`)
// All users answer concurrently (exercises per-user isolation and the per-session task queue).
await Promise.all(users.map(async (u) => {
  for (const [i, text] of answers[u]!.entries()) {
    await call(`/trips/${tripId}/onboarding/messages`, u, { method: "POST", body: JSON.stringify({ clientMessageId: `${u}-${i}`, text }) })
    await sleep(1200)
  }
}))
for (let i = 0; i < 30; i++) {
  const v = await call(`/trips/${tripId}`, users[0]!)
  const runId = v.runIds.at(-1)
  if (runId) {
    const rv = await call(`/trips/${tripId}/runs/${runId}`, users[0]!)
    if (["completed", "needs_input", "failed"].includes(rv.run.status)) {
      console.log(JSON.stringify({ runId, status: rv.run.status, capture: rv.run.captureStatus, rounds: rv.run.currentRound, modelCalls: rv.run.modelCalls, transcript: rv.transcript.length, conflicts: rv.run.result?.conflicts?.length ?? 0, violated: rv.run.result?.constraintReport?.filter((c: { outcome: string }) => c.outcome === "violated").length ?? 0, missingResponses: rv.run.missingResponses, failure: rv.run.failure }, null, 1))
      const txt = await call(`/trips/${tripId}/runs/${runId}/transcript?format=txt`, users[0]!)
      console.log(String(txt).split("=== Summary ===")[1]?.slice(0, 1200))
      // isolation: another participant must not see the first user's onboarding
      const other = await call(`/trips/${tripId}/onboarding`, users[1]!)
      console.log(`isolation ok: ${users[1]} sees only own session (${other.session.userId})`)
      process.exit(0)
    }
  } else {
    const readiness = v.readiness.map((p: { userId: string; ready: boolean }) => `${p.userId}:${p.ready ? "ready" : "…"}`).join(" ")
    console.log(`waiting: ${readiness}`)
  }
  await sleep(1500)
}
console.error("timed out waiting for a terminal run")
process.exit(1)
