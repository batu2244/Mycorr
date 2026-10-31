/**
 * Seeds a demo trip with N users (2 or 5) and prints the ids plus suggested answers for
 * the web UI at http://127.0.0.1:3000. Development identities only.
 * Usage: bun run scripts/seed.ts [2|5] [baseUrl]
 */
const count = Number(process.argv[2] ?? 2)
const base = process.argv[3] ?? "http://127.0.0.1:3000"
const users = ["ana", "ben", "cat", "dan", "eve"].slice(0, count)
const r = await fetch(`${base}/api/trips`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-mycorr-user": users[0]! },
  body: JSON.stringify({ title: `Lisbon weekend (${count} people)`, city: "Lisbon", dateRange: { start: "2026-11-20", end: "2026-11-22" }, participantIds: users.slice(1) }),
})
if (!r.ok) throw new Error(`seed failed: ${r.status} ${await r.text()}`)
const view = await r.json()
console.log(`trip id: ${view.trip.tripId}`)
console.log(`participants: ${users.join(", ")}`)
console.log(`\nOpen ${base}, paste the trip id, set "I am" to a user id, and answer. Example answers:`)
console.log(`  ana: I am free the whole weekend. Roughly €100 per day all-in, and no total limit. I love food and museums, no bars. Totally flexible.`)
console.log(`  ben: Only Saturday afternoon for me. Budget is 80 euros.   -> agent asks daily or total`)
console.log(`       Daily, around 80 euros per day all-in, flexible. No total limit either. I like nature and bars. Flexible on schedule, fixed: no museums.`)
