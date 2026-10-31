/** Debug helper: prints onboarding state for every member of the latest (or given) trip. */
import { actors } from "@mycorr/actors/client"
const registry = actors.RegistryActor.get("global")
const tripId = process.argv[2] ?? (await registry.listTrips()).at(-1)!
console.log("trip", tripId)
for (const userId of await registry.listTripMembers(tripId)) {
  const s = await actors.UserActor.get(userId).getOnboarding(tripId)
  if (!s) continue
  console.log(`\n== ${userId}: ${s.session.status} missing=${s.missingFields.join(",")} pendingTask=${s.pendingTask ? `${s.pendingTask.status} attempts=${s.pendingTask.attempts} err=${s.pendingTask.error ?? ""}` : "none"}`)
  for (const m of s.messages) console.log(`  ${m.role}: ${m.text}`)
  for (const [k, v] of Object.entries(s.requirements.fields)) console.log(`  field ${k}: ${v.status} ${v.value !== undefined ? JSON.stringify(v.value) : ""} ${v.note ?? ""}`)
}
