import { AgentRelay, type RelayAgentClient } from "@agent-relay/sdk"
import type { AgentMessaging, RegisteredAgent, RelayAdmin, RelayMessageRecord, SendOptions } from "./types.js"

/**
 * REAL Agent Relay adapter (@agent-relay/sdk 15.0.1). Verified live on 2026-10-31 against the
 * hosted service: createWorkspace, workspace.register, channels.create/join, sendMessage with
 * metadata, messages.list, addListener("message.created"), workspace.reconnect.
 *
 * Observed behaviour this adapter compensates for:
 * - addListener does not reliably report every message sent from this process, so every send
 *   made through this adapter is also emitted to subscribers directly. Deduplicated by message id.
 * - messages.list returns newest first; listMessages returns oldest first (ids are snowflakes).
 */
export class RealRelay implements RelayAdmin {
  readonly name = "agent-relay"
  private readonly relay: AgentRelay
  private readonly clients = new Map<string, RelayAgentClient>() // apiToken -> live client
  private readonly channelIds = new Map<string, string>()
  private readonly observers = new Set<(m: RelayMessageRecord) => Promise<void>>()
  private readonly seen = new Set<string>()
  private readonly agentHandlers = new Map<string, Set<(m: RelayMessageRecord) => Promise<void>>>()
  private readonly memberships = new Map<string, Set<string>>() // agentName -> channel names
  private admin?: RelayAgentClient
  private unlisten?: () => void

  constructor(private readonly workspaceKey: string) {
    this.relay = new AgentRelay({ workspaceKey })
    this.unlisten = this.relay.addListener("message.created", ({ message }: { message: any }) => {
      const record = toRecord(message, this.channelIds)
      if (record) this.emit(record)
    })
  }

  async workspaceRef(): Promise<string> {
    return `agent-relay:${this.workspaceKey.slice(0, 10)}`
  }

  async registerAgent(agentName: string): Promise<RegisteredAgent> {
    const client = await this.relay.workspace.register({ name: relayName(agentName), type: "agent" })
    if (!client.token) throw new Error(`relay register returned no token for ${agentName}`)
    this.clients.set(client.token, client)
    return { agentName: client.name, agentId: client.id, apiToken: client.token }
  }

  /** Channels are created by a coordinator-owned agent, so the channel exists before participants join. */
  async createChannel(channelName: string, topic: string) {
    const name = relayName(channelName)
    if (!this.admin) this.admin = await this.relay.workspace.register({ name: `mycorr-coordinator-${crypto.randomUUID().slice(0, 8)}`, type: "agent" })
    const ch = await this.admin.channels.create({ name, topic } as never)
    this.channelIds.set(name, ch.id)
    return { channelId: ch.id, channelName: name }
  }

  async sendAs(apiToken: string, channelName: string, text: string, options?: SendOptions) {
    const client = await this.client(apiToken)
    const name = channelName.replace(/^#/, "")
    await this.ensureJoined(client, name)
    return this.send(client, name, text, options)
  }

  async listMessages(channelName: string, options?: { after?: string; limit?: number }): Promise<RelayMessageRecord[]> {
    const name = channelName.replace(/^#/, "")
    const reader = this.admin ?? this.clients.values().next().value
    if (!reader) return []
    const all: any[] = []
    let before: string | undefined
    for (let page = 0; page < 50; page++) {
      const batch: any[] = await reader.messages.list(name, { limit: 100, ...(before ? { before } : {}) })
      all.push(...batch)
      if (batch.length < 100) break
      before = batch.map((m) => m.id).sort(bySnowflake)[0]
    }
    let records = all.map((m) => toRecord(m, this.channelIds, name)!).filter(Boolean)
    records = dedupe(records).sort((a, b) => bySnowflake(a.id, b.id))
    if (options?.after) {
      const idx = records.findIndex((m) => m.id === options.after)
      if (idx >= 0) records = records.slice(idx + 1)
    }
    return options?.limit ? records.slice(0, options.limit) : records
  }

  subscribe(handler: (message: RelayMessageRecord) => Promise<void>): () => void {
    this.observers.add(handler)
    return () => this.observers.delete(handler)
  }

  async connectAgent(apiToken: string): Promise<AgentMessaging> {
    const client = await this.client(apiToken)
    return new RealAgentMessaging(this, client)
  }

  async close(): Promise<void> {
    this.unlisten?.()
    this.observers.clear()
    this.agentHandlers.clear()
  }

  // ---- internals used by RealAgentMessaging ---------------------------------

  async ensureJoined(client: RelayAgentClient, channelName: string): Promise<void> {
    const set = this.memberships.get(client.name) ?? new Set<string>()
    if (set.has(channelName)) return
    await client.channels.join(channelName)
    set.add(channelName)
    this.memberships.set(client.name, set)
  }

  async send(client: RelayAgentClient, channelName: string, text: string, options?: SendOptions) {
    const sent: any = await client.sendMessage({
      to: `#${channelName}`,
      text,
      ...(options?.metadata ? { metadata: options.metadata } : {}),
      ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options?.mentions?.length ? { mentions: options.mentions } : {}),
    })
    const record = toRecord(sent, this.channelIds, channelName)
    if (record) {
      if (options?.replyToMessageId) record.replyToMessageId = options.replyToMessageId
      this.emit(record)
    }
    return { messageId: String(sent.id) }
  }

  addAgentHandler(agentName: string, handler: (m: RelayMessageRecord) => Promise<void>): () => void {
    const set = this.agentHandlers.get(agentName) ?? new Set()
    set.add(handler)
    this.agentHandlers.set(agentName, set)
    return () => set.delete(handler)
  }

  private emit(record: RelayMessageRecord): void {
    if (this.seen.has(record.id)) return
    this.seen.add(record.id)
    queueMicrotask(() => {
      for (const o of this.observers) void o(record).catch((e) => console.error("[agent-relay] observer failed", e))
      for (const [agentName, handlers] of this.agentHandlers) {
        if (agentName === record.fromAgent) continue // never deliver an agent its own message
        if (!this.memberships.get(agentName)?.has(record.channelName)) continue
        for (const h of handlers) void h(record).catch((e) => console.error(`[agent-relay] ${agentName} handler failed`, e))
      }
    })
  }

  private async client(apiToken: string): Promise<RelayAgentClient> {
    let client = this.clients.get(apiToken)
    if (!client) {
      client = await this.relay.workspace.reconnect({ apiToken })
      this.clients.set(apiToken, client)
    }
    return client
  }
}

class RealAgentMessaging implements AgentMessaging {
  private unsubs: (() => void)[] = []
  constructor(private readonly bus: RealRelay, private readonly client: RelayAgentClient) {}
  get agentName() {
    return this.client.name
  }
  join(channelName: string) {
    return this.bus.ensureJoined(this.client, channelName.replace(/^#/, ""))
  }
  send(channelName: string, text: string, options?: SendOptions) {
    return this.bus.send(this.client, channelName.replace(/^#/, ""), text, options)
  }
  onMessage(handler: (message: RelayMessageRecord) => Promise<void>): () => void {
    const off = this.bus.addAgentHandler(this.client.name, handler)
    this.unsubs.push(off)
    return off
  }
  async close(): Promise<void> {
    for (const off of this.unsubs) off()
    this.unsubs = []
  }
}

function toRecord(m: any, channelIds: Map<string, string>, fallbackChannel?: string): RelayMessageRecord | undefined {
  const channelName = String(m?.channel?.name ?? fallbackChannel ?? "").replace(/^#/, "")
  if (!m?.id || !channelName) return undefined
  return {
    id: String(m.id),
    channelId: String(m.channel?.id ?? channelIds.get(channelName) ?? channelName),
    channelName,
    fromAgent: String(m.from?.name ?? m.from?.handle ?? "unknown"),
    text: String(m.text ?? ""),
    createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : new Date().toISOString(),
    replyToMessageId: m.parentId ?? undefined,
    mentions: Array.isArray(m.mentions) ? m.mentions.map(String) : [],
    metadata: m.metadata ?? undefined,
  }
}

/** Relay names must be lowercase alphanumeric and hyphens, starting with a letter or digit. */
function relayName(raw: string): string {
  const name = raw.replace(/^#/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
  return (name || "mycorr").slice(0, 80)
}

function dedupe(records: RelayMessageRecord[]): RelayMessageRecord[] {
  const byId = new Map<string, RelayMessageRecord>()
  for (const r of records) byId.set(r.id, r)
  return [...byId.values()]
}

function bySnowflake(a: string, b: string): number {
  try {
    const x = BigInt(a), y = BigInt(b)
    return x < y ? -1 : x > y ? 1 : 0
  } catch {
    return a < b ? -1 : a > b ? 1 : 0
  }
}
