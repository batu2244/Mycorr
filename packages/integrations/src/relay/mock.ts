import type { AgentMessaging, RegisteredAgent, RelayAdmin, RelayMessageRecord, SendOptions } from "./types.js"

/**
 * MOCK RELAY - in-memory message bus with the delivery semantics we rely on: channel
 * membership, ordered history, mention parsing, asynchronous delivery to every member
 * except the sender. Not a network service; says nothing about the real Agent Relay.
 */
export class MockRelay implements RelayAdmin {
  readonly name = "mock"
  private readonly agents = new Map<string, RegisteredAgent>()
  private readonly channels = new Map<string, { channelId: string; members: Set<string>; messages: RelayMessageRecord[] }>()
  private readonly sessions = new Map<string, MockAgentMessaging[]>()
  private readonly observers = new Set<(m: RelayMessageRecord) => Promise<void>>()
  private counter = 0

  async workspaceRef(): Promise<string> {
    return "mock-workspace"
  }

  async registerAgent(agentName: string): Promise<RegisteredAgent> {
    for (const a of this.agents.values()) if (a.agentName === agentName) throw new Error(`name_conflict: ${agentName}`)
    const agent: RegisteredAgent = { agentName, agentId: `mock-agent-${++this.counter}`, apiToken: `mock-token-${crypto.randomUUID()}` }
    this.agents.set(agent.apiToken, agent)
    return agent
  }

  async createChannel(channelName: string, _topic: string) {
    const name = channelName.replace(/^#/, "")
    if (!this.channels.has(name)) this.channels.set(name, { channelId: `mock-ch-${++this.counter}`, members: new Set(), messages: [] })
    return { channelId: this.channels.get(name)!.channelId, channelName: name }
  }

  async sendAs(apiToken: string, channelName: string, text: string, options?: SendOptions) {
    const agent = this.agents.get(apiToken)
    if (!agent) throw new Error("invalid agent token")
    return this.publish(agent.agentName, channelName, text, options)
  }

  async listMessages(channelName: string, options?: { after?: string; limit?: number }): Promise<RelayMessageRecord[]> {
    const ch = this.channels.get(channelName.replace(/^#/, ""))
    if (!ch) return []
    let msgs = ch.messages
    if (options?.after) {
      const idx = msgs.findIndex((m) => m.id === options.after)
      msgs = idx >= 0 ? msgs.slice(idx + 1) : msgs
    }
    return options?.limit ? msgs.slice(0, options.limit) : [...msgs]
  }

  subscribe(handler: (message: RelayMessageRecord) => Promise<void>): () => void {
    this.observers.add(handler)
    return () => this.observers.delete(handler)
  }

  async connectAgent(apiToken: string): Promise<AgentMessaging> {
    const agent = this.agents.get(apiToken)
    if (!agent) throw new Error("invalid agent token")
    const session = new MockAgentMessaging(this, agent.agentName)
    const list = this.sessions.get(agent.agentName) ?? []
    list.push(session)
    this.sessions.set(agent.agentName, list)
    return session
  }

  async close(): Promise<void> {
    this.observers.clear()
    this.sessions.clear()
  }

  joinChannel(agentName: string, channelName: string): void {
    const name = channelName.replace(/^#/, "")
    if (!this.channels.has(name)) this.channels.set(name, { channelId: `mock-ch-${++this.counter}`, members: new Set(), messages: [] })
    this.channels.get(name)!.members.add(agentName)
  }

  detach(session: MockAgentMessaging): void {
    const list = this.sessions.get(session.agentName) ?? []
    this.sessions.set(session.agentName, list.filter((s) => s !== session))
  }

  publish(fromAgent: string, channelName: string, text: string, options?: SendOptions): { messageId: string } {
    const name = channelName.replace(/^#/, "")
    const ch = this.channels.get(name)
    if (!ch) throw new Error(`unknown channel ${name}`)
    const mentions = Array.from(new Set([...(options?.mentions ?? []), ...Array.from(text.matchAll(/@([A-Za-z0-9_.-]+)/g)).map((m) => m[1]!)]))
    const message: RelayMessageRecord = {
      id: `mockmsg_${++this.counter}_${crypto.randomUUID().slice(0, 8)}`,
      channelId: ch.channelId,
      channelName: name,
      fromAgent,
      text,
      createdAt: new Date().toISOString(),
      replyToMessageId: options?.replyToMessageId,
      mentions,
      metadata: options?.metadata,
    }
    ch.messages.push(message)
    queueMicrotask(() => {
      for (const o of this.observers) void o(message).catch((e) => console.error("[mock-relay] observer failed", e))
      for (const member of ch.members) {
        if (member === fromAgent) continue
        for (const s of this.sessions.get(member) ?? []) s.deliver(message)
      }
    })
    return { messageId: message.id }
  }
}

class MockAgentMessaging implements AgentMessaging {
  private handlers = new Set<(m: RelayMessageRecord) => Promise<void>>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly bus: MockRelay, readonly agentName: string) {}

  async join(channelName: string): Promise<void> {
    this.bus.joinChannel(this.agentName, channelName)
  }

  async send(channelName: string, text: string, options?: SendOptions) {
    return this.bus.publish(this.agentName, channelName, text, options)
  }

  onMessage(handler: (message: RelayMessageRecord) => Promise<void>): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  deliver(message: RelayMessageRecord): void {
    for (const h of this.handlers) this.queue = this.queue.then(() => h(message)).catch((e) => console.error(`[mock-relay] ${this.agentName} handler failed`, e))
  }

  async close(): Promise<void> {
    this.handlers.clear()
    this.bus.detach(this)
  }
}
