// Live check of RealRelay, mirroring how the demo coordinator uses RelayAdmin. Needs RELAY_WORKSPACE_KEY.
import { RealRelay } from "../src/relay/real.js"
const key = process.env.RELAY_WORKSPACE_KEY
if (!key) throw new Error("RELAY_WORKSPACE_KEY not set")
const relay = new RealRelay(key)
const sfx = crypto.randomUUID().slice(0, 6)
const ch = await relay.createChannel(`check-${sfx}`, "relay check")
const a = await relay.registerAgent(`ana-${sfx}`)
const b = await relay.registerAgent(`ben-${sfx}`)
const recorded: string[] = []
relay.subscribe(async (m) => { recorded.push(m.id) })
const sa = await relay.connectAgent(a.apiToken); await sa.join(ch.channelName)
const sb = await relay.connectAgent(b.apiToken); await sb.join(ch.channelName)
const bInbox: string[] = []
sb.onMessage(async (m) => { bInbox.push(m.text) })
await relay.sendAs(a.apiToken, ch.channelName, "Round 1: propose", { metadata: { mycorr: { kind: "task" } } })
await sa.send(ch.channelName, "ana proposal", { metadata: { mycorr: { kind: "result" } } })
await sb.send(ch.channelName, "ben proposal")
await new Promise((r) => setTimeout(r, 2500))
const hist = await relay.listMessages(ch.channelName)
console.log("history (oldest first):", hist.map((m) => `${m.fromAgent}: ${m.text}`).join(" | "))
console.log("recorder got", new Set(recorded).size, "of", hist.length, "| missing:", hist.filter((h) => !recorded.includes(h.id)).length)
console.log("ben received (not own):", bInbox)
console.log("metadata kept:", JSON.stringify(hist[0]?.metadata))
await relay.close()
process.exit(0)
