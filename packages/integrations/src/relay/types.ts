/** Provider-neutral view of a Relay message, enough for the recorder and the agent runner. */
export interface RelayMessageRecord {
  id: string
  channelId: string
  channelName: string
  fromAgent: string
  text: string
  createdAt: string
  replyToMessageId?: string
  mentions: string[]
  metadata?: Record<string, unknown>
}

export interface RegisteredAgent {
  agentName: string
  agentId: string
  /** Agent-scoped API token. Store in TripActor.run_credentials only. */
  apiToken: string
}

export interface SendOptions {
  replyToMessageId?: string
  mentions?: string[]
  metadata?: Record<string, unknown>
  idempotencyKey?: string
}

/** A live agent connection. Delivery of a message is what triggers the agent's model turn. */
export interface AgentMessaging {
  readonly agentName: string
  join(channelName: string): Promise<void>
  send(channelName: string, text: string, options?: SendOptions): Promise<{ messageId: string }>
  onMessage(handler: (message: RelayMessageRecord) => Promise<void>): () => void
  close(): Promise<void>
}

/** Workspace-level operations the coordinator performs with the server-side Relay credential. */
export interface RelayAdmin {
  readonly name: string
  workspaceRef(): Promise<string>
  registerAgent(agentName: string): Promise<RegisteredAgent>
  createChannel(channelName: string, topic: string): Promise<{ channelId: string; channelName: string }>
  sendAs(apiToken: string, channelName: string, text: string, options?: SendOptions): Promise<{ messageId: string }>
  listMessages(channelName: string, options?: { after?: string; limit?: number }): Promise<RelayMessageRecord[]>
  subscribe(handler: (message: RelayMessageRecord) => Promise<void>): () => void
  connectAgent(apiToken: string): Promise<AgentMessaging>
  close(): Promise<void>
}
