import { Actor, Persisted, type ActorContext } from "durable-actors"
import {
  PROFILE_SCHEMA_VERSION,
  TERMINAL_RUN_STATUSES,
  type CaptureStatus,
  type Evaluation,
  type Itinerary,
  type ParticipantReadiness,
  type PlanningRun,
  type PlanningTask,
  type Proposal,
  type ReadinessNotification,
  type RunLimits,
  type RunParticipantSnapshot,
  type RunResult,
  type RunStatus,
  type TranscriptCapture,
  type TranscriptMessage,
  type Trip,
  type TripInvite,
  type TripView,
  type WebhookDelivery,
} from "@mycorr/contracts"
import { ensureTables, json, parseJson, text } from "./sql.js"
import { insertPlanningTask, insertRun, loadRun, markRunTasksStale, nextTranscriptSequence, requireRun, rowToPlanningTask, saveRun } from "./trip-store.js"

export interface CreateTripRecord {
  tripId: string
  title: string
  city: string
  dateRange: { start: string; end: string }
  timezone: string
  context?: string
  creatorId: string
  participantIds: string[]
}

export interface ReadinessOutcome {
  accepted: boolean
  duplicate: boolean
  allReady: boolean
  startedRunId?: string
  staleRunId?: string
}

export interface AgentCredential {
  userId: string
  agentName: string
  /** Relay agent API token. Coordinator-only; never returned by public getters. */
  apiToken: string
}

export interface RunProgress {
  currentRound?: number
  modelCalls?: number
  totalTokens?: number
  missingResponses?: string[]
  candidateItinerary?: Itinerary
}

export interface RecordTranscriptResult {
  inserted: number
  duplicates: number
  nextSequence: number
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    input_revision TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS planning_tasks (
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until TEXT,
    claimed_by TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transcript (
    id TEXT PRIMARY KEY,
    relay_message_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    sender_agent_id TEXT NOT NULL,
    represented_user_id TEXT,
    channel_id TEXT NOT NULL,
    reply_to_message_id TEXT,
    sent_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    text TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS transcript_run ON transcript (run_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS proposals (
    proposal_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    by_user_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evaluations (
    run_id TEXT NOT NULL,
    by_user_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, by_user_id, proposal_id, round)
  )`,
  `CREATE TABLE IF NOT EXISTS processed_notifications (
    event_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS run_credentials (
    run_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    api_token TEXT NOT NULL,
    PRIMARY KEY (run_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    data TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
]

/**
 * TripActor(tripId): owns shared planning state. Readiness notifications arrive
 * from UserActors via the coordinator and are idempotent on eventId. When every
 * participant is ready, exactly one run per input revision is queued.
 */
export class TripActor extends Actor {
  @Persisted private trip: Trip | undefined = undefined
  @Persisted private readiness: Record<string, ParticipantReadiness> = {}
  @Persisted private activeRunId: string | undefined = undefined
  @Persisted private relayWorkspaceRef: string | undefined = undefined
  @Persisted private defaultLimits: RunLimits = { maxRounds: 3, deadlineMs: 5 * 60_000, maxModelCalls: 40, maxTotalTokens: 400_000 }

  constructor(context: ActorContext) {
    super(context)
    ensureTables(this.db, TABLES)
  }

  // ---- trip ----------------------------------------------------------------------

  async create(input: CreateTripRecord): Promise<Trip> {
    if (this.trip) return this.trip
    const now = new Date().toISOString()
    const participants = Array.from(new Set(input.participantIds))
    this.trip = {
      tripId: input.tripId,
      title: input.title,
      city: input.city,
      dateRange: input.dateRange,
      timezone: input.timezone,
      context: input.context,
      creatorId: input.creatorId,
      participantIds: participants,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    const readiness: Record<string, ParticipantReadiness> = {}
    for (const userId of participants) readiness[userId] = { userId, ready: false }
    this.readiness = readiness
    return this.trip
  }

  async exists(): Promise<boolean> {
    return this.trip !== undefined
  }

  async get(): Promise<TripView | null> {
    if (!this.trip) return null
    return {
      trip: this.trip,
      readiness: this.trip.participantIds.map((id) => this.readiness[id] ?? { userId: id, ready: false }),
      activeRunId: this.activeRunId,
      runIds: this.db.exec<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY created_at ASC`).map((r) => r.run_id),
    }
  }

  async isParticipant(userId: string): Promise<boolean> {
    return this.trip?.participantIds.includes(userId) ?? false
  }

  async setLimits(limits: RunLimits): Promise<void> {
    this.defaultLimits = limits
  }

  async setRelayWorkspaceRef(ref: string): Promise<void> {
    this.relayWorkspaceRef = ref
  }

  // ---- invitations --------------------------------------------------------------------

  async createInvite(createdBy: string): Promise<TripInvite> {
    if (!this.trip) throw new Error("trip does not exist")
    if (!this.trip.participantIds.includes(createdBy)) throw new Error("only participants can invite")
    const invite: TripInvite = { token: `inv_${crypto.randomUUID().replace(/-/g, "")}`, tripId: this.id, createdBy, createdAt: new Date().toISOString(), acceptedBy: [] }
    this.db.exec(`INSERT INTO invites (token, created_by, created_at, accepted_by) VALUES (?, ?, ?, ?)`, invite.token, createdBy, invite.createdAt, "[]")
    return invite
  }

  async getInvite(token: string): Promise<TripInvite | null> {
    const row = this.db.exec(`SELECT * FROM invites WHERE token = ?`, token)[0]
    if (!row) return null
    return { token, tripId: this.id, createdBy: text(row.created_by)!, createdAt: text(row.created_at)!, acceptedBy: parseJson<string[]>(row.accepted_by, []) }
  }

  /** Adds the caller as a participant (new trip revision). Idempotent for existing members. Marks an active run stale. */
  async acceptInvite(token: string, userId: string): Promise<{ tripId: string; added: boolean; staleRunId?: string }> {
    if (!this.trip) throw new Error("trip does not exist")
    const invite = await this.getInvite(token)
    if (!invite) throw new Error("invalid invite")
    if (this.trip.participantIds.includes(userId)) return { tripId: this.id, added: false }
    const now = new Date().toISOString()
    let staleRunId: string | undefined
    await this.db.transaction(async () => {
      this.trip = { ...this.trip!, participantIds: [...this.trip!.participantIds, userId], version: this.trip!.version + 1, updatedAt: now }
      this.readiness = { ...this.readiness, [userId]: { userId, ready: false } }
      this.db.exec(`UPDATE invites SET accepted_by = ? WHERE token = ?`, json([...invite.acceptedBy, userId]), token)
      const active = this.activeRunId ? loadRun(this.db, this.activeRunId) : undefined
      if (active && !TERMINAL_RUN_STATUSES.includes(active.status)) {
        await this.applyStaleLocked(active, `participant ${userId} joined (trip v${this.trip.version})`, now)
        staleRunId = active.runId
      }
    })
    return { tripId: this.id, added: true, staleRunId }
  }

  // ---- readiness and automatic run start -------------------------------------------

  async participantReady(notification: ReadinessNotification, snapshot?: RunParticipantSnapshot): Promise<ReadinessOutcome> {
    if (!this.trip) throw new Error("trip does not exist")
    if (!this.trip.participantIds.includes(notification.userId)) throw new Error("user is not a participant")
    const seen = this.db.exec(`SELECT event_id FROM processed_notifications WHERE event_id = ?`, notification.eventId)[0]
    if (seen) return { accepted: true, duplicate: true, allReady: allReady(this.trip, this.readiness), startedRunId: undefined }

    const now = new Date().toISOString()
    let startedRunId: string | undefined
    let staleRunId: string | undefined
    await this.db.transaction(async () => {
      this.db.exec(`INSERT INTO processed_notifications (event_id, received_at) VALUES (?, ?)`, notification.eventId, now)
      const previous = this.readiness[notification.userId]
      this.readiness = {
        ...this.readiness,
        [notification.userId]: {
          userId: notification.userId,
          ready: notification.ready,
          profileVersion: notification.profileVersion,
          schemaVersion: notification.schemaVersion,
          updatedAt: now,
        },
      }
      // A relevant change while a run is active makes that run stale.
      const active = this.activeRunId ? loadRun(this.db, this.activeRunId) : undefined
      if (active && previous && previous.profileVersion !== notification.profileVersion && !TERMINAL_RUN_STATUSES.includes(active.status)) {
        await this.applyStaleLocked(active, `participant ${notification.userId} changed profile (v${previous.profileVersion} -> v${notification.profileVersion})`, now)
        staleRunId = active.runId
      }
      if (allReady(this.trip, this.readiness) && !this.activeRunId && snapshot) {
        startedRunId = await this.enqueueRunLocked(now, [snapshot])
      }
    })
    return { accepted: true, duplicate: false, allReady: allReady(this.trip, this.readiness), startedRunId, staleRunId }
  }

  /**
   * Queues a run when all participants are ready and no run exists for this input
   * revision. The coordinator calls this with fresh snapshots of every participant
   * (it fetched them from the UserActors) once participantReady reports allReady.
   */
  async queueRunIfReady(snapshots: RunParticipantSnapshot[]): Promise<{ runId?: string; reason: string }> {
    if (!this.trip) throw new Error("trip does not exist")
    if (!allReady(this.trip, this.readiness)) return { reason: "not all participants are ready" }
    if (this.activeRunId) return { runId: this.activeRunId, reason: "a run is already active" }
    const ids = new Set(snapshots.map((s) => s.userId))
    for (const id of this.trip.participantIds) if (!ids.has(id)) return { reason: `missing snapshot for ${id}` }
    const revision = inputRevision(this.trip!, snapshots)
    const dup = this.db.exec<{ run_id: string; status: string }>(`SELECT run_id, status FROM runs WHERE input_revision = ?`, revision)[0]
    if (dup && dup.status !== "stale" && dup.status !== "failed" && dup.status !== "cancelled") {
      return { runId: dup.run_id, reason: "a run for this input revision already exists" }
    }
    const now = new Date().toISOString()
    let runId = ""
    await this.db.transaction(async () => {
      runId = await this.enqueueRunLocked(now, snapshots)
    })
    return { runId, reason: "queued" }
  }

  // ---- planning task queue ---------------------------------------------------------

  async claimPlanningTask(workerId: string, leaseMs: number): Promise<PlanningTask | null> {
    const now = new Date()
    const nowIso = now.toISOString()
    const row = this.db.exec(
      `SELECT * FROM planning_tasks
        WHERE status = 'pending' OR (status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?)
        ORDER BY created_at ASC LIMIT 1`,
      nowIso,
    )[0]
    if (!row) return null
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
    this.db.exec(
      `UPDATE planning_tasks SET status = 'claimed', attempts = attempts + 1, lease_until = ?, claimed_by = ?, updated_at = ? WHERE task_id = ?`,
      leaseUntil, workerId, nowIso, row.task_id as string,
    )
    const task = rowToPlanningTask(row as Record<string, string | number | bigint | Uint8Array | null>, this.id)
    return { ...task, status: "claimed", attempts: task.attempts + 1, leaseUntil, claimedBy: workerId }
  }

  async extendLease(taskId: string, leaseMs: number): Promise<void> {
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString()
    this.db.exec(`UPDATE planning_tasks SET lease_until = ? WHERE task_id = ? AND status = 'claimed'`, leaseUntil, taskId)
  }

  async completePlanningTask(taskId: string): Promise<void> {
    this.db.exec(`UPDATE planning_tasks SET status = 'done', updated_at = ? WHERE task_id = ? AND status = 'claimed'`, new Date().toISOString(), taskId)
  }

  async failPlanningTask(taskId: string, error: string, retry: boolean): Promise<void> {
    this.db.exec(
      `UPDATE planning_tasks SET status = ?, error = ?, lease_until = NULL, updated_at = ? WHERE task_id = ? AND status = 'claimed'`,
      retry ? "pending" : "failed", error, new Date().toISOString(), taskId,
    )
  }

  async enqueuePlanningTask(runId: string, kind: PlanningTask["kind"], payload: Record<string, unknown>): Promise<string> {
    return insertPlanningTask(this.db, runId, kind, payload, new Date().toISOString())
  }

  // ---- run lifecycle ----------------------------------------------------------------

  async startRun(runId: string, relay: PlanningRun["relay"], participantAgentNames: Record<string, string>): Promise<PlanningRun> {
    const run = requireRun(this.db, runId)
    if (run.status !== "queued" && run.status !== "running") throw new Error(`run is ${run.status}`)
    const now = new Date().toISOString()
    const next: PlanningRun = {
      ...run,
      status: "running",
      startedAt: run.startedAt ?? now,
      relay: { ...run.relay, ...relay },
      participants: run.participants.map((p) => ({ ...p, agentName: participantAgentNames[p.userId] ?? p.agentName })),
    }
    saveRun(this.db, next)
    return next
  }

  async updateRunProgress(runId: string, progress: RunProgress): Promise<PlanningRun> {
    const run = requireRun(this.db, runId)
    const next: PlanningRun = {
      ...run,
      currentRound: progress.currentRound ?? run.currentRound,
      modelCalls: progress.modelCalls ?? run.modelCalls,
      totalTokens: progress.totalTokens ?? run.totalTokens,
      missingResponses: progress.missingResponses ?? run.missingResponses,
    }
    if (progress.candidateItinerary) {
      ;(next as PlanningRun & { candidateItinerary?: Itinerary }).candidateItinerary = progress.candidateItinerary
    }
    saveRun(this.db, next)
    return next
  }

  async recordProposal(runId: string, proposal: Proposal): Promise<void> {
    requireRun(this.db, runId)
    this.db.exec(
      `INSERT INTO proposals (proposal_id, run_id, by_user_id, round, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(proposal_id) DO NOTHING`,
      proposal.proposalId, runId, proposal.byUserId, proposal.round, json(proposal), proposal.createdAt,
    )
  }

  async recordEvaluation(runId: string, evaluation: Evaluation): Promise<void> {
    requireRun(this.db, runId)
    this.db.exec(
      `INSERT INTO evaluations (run_id, by_user_id, proposal_id, round, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, by_user_id, proposal_id, round) DO UPDATE SET data = excluded.data`,
      runId, evaluation.byUserId, evaluation.proposalId, evaluation.round, json(evaluation), evaluation.createdAt,
    )
  }

  async listProposals(runId: string): Promise<Proposal[]> {
    return this.db.exec(`SELECT data FROM proposals WHERE run_id = ? ORDER BY created_at ASC`, runId).map((r) => parseJson<Proposal>(r.data, undefined as never))
  }

  async listEvaluations(runId: string): Promise<Evaluation[]> {
    return this.db.exec(`SELECT data FROM evaluations WHERE run_id = ? ORDER BY created_at ASC`, runId).map((r) => parseJson<Evaluation>(r.data, undefined as never))
  }

  /** Finishes a run with a terminal status. Clears the active run slot. */
  async finishRun(runId: string, status: RunStatus, result?: RunResult, failure?: string): Promise<PlanningRun> {
    if (!TERMINAL_RUN_STATUSES.includes(status)) throw new Error(`${status} is not terminal`)
    const run = requireRun(this.db, runId)
    const now = new Date().toISOString()
    const next: PlanningRun = { ...run, status, result: result ?? run.result, failure, finishedAt: now }
    await this.db.transaction(async () => {
      saveRun(this.db, next)
      if (this.activeRunId === runId) this.activeRunId = undefined
    })
    return next
  }

  async markRunStale(runId: string, reason: string): Promise<PlanningRun> {
    const run = requireRun(this.db, runId)
    const now = new Date().toISOString()
    await this.db.transaction(async () => {
      await this.applyStaleLocked(run, reason, now)
    })
    return requireRun(this.db, runId)
  }

  async setCaptureStatus(runId: string, captureStatus: CaptureStatus): Promise<void> {
    const run = requireRun(this.db, runId)
    saveRun(this.db, { ...run, captureStatus })
  }

  // ---- transcript (recorder) --------------------------------------------------------

  /** Append-only, deduplicated on relayMessageId. Sequence is assigned here in capture order. */
  async recordTranscript(runId: string, captures: TranscriptCapture[]): Promise<RecordTranscriptResult> {
    requireRun(this.db, runId)
    const now = new Date().toISOString()
    let inserted = 0
    let duplicates = 0
    let seq = nextTranscriptSequence(this.db, runId)
    await this.db.transaction(async () => {
      for (const c of captures) {
        const dup = this.db.exec(`SELECT id FROM transcript WHERE relay_message_id = ?`, c.relayMessageId)[0]
        if (dup) {
          duplicates++
          continue
        }
        this.db.exec(
          `INSERT INTO transcript (id, relay_message_id, run_id, sequence, sender_agent_id, represented_user_id, channel_id, reply_to_message_id, sent_at, recorded_at, text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          `tm_${crypto.randomUUID().replace(/-/g, "")}`, c.relayMessageId, runId, seq++, c.senderAgentId, c.representedUserId ?? null,
          c.channelId, c.replyToMessageId ?? null, c.sentAt, now, c.text,
        )
        inserted++
      }
    })
    return { inserted, duplicates, nextSequence: seq }
  }

  async getTranscript(runId: string): Promise<TranscriptMessage[]> {
    return this.db.exec(`SELECT * FROM transcript WHERE run_id = ? ORDER BY sequence ASC`, runId).map((row) => {
      const r = row as Record<string, string | number | null>
      return {
        id: String(r.id),
        relayMessageId: String(r.relay_message_id),
        tripId: this.id,
        runId: String(r.run_id),
        sequence: Number(r.sequence),
        senderAgentId: String(r.sender_agent_id),
        representedUserId: r.represented_user_id ? String(r.represented_user_id) : undefined,
        channelId: String(r.channel_id),
        replyToMessageId: r.reply_to_message_id ? String(r.reply_to_message_id) : undefined,
        sentAt: String(r.sent_at),
        recordedAt: String(r.recorded_at),
        text: String(r.text),
      }
    })
  }

  async getRun(runId: string): Promise<PlanningRun | null> {
    return loadRun(this.db, runId) ?? null
  }

  async listRuns(): Promise<PlanningRun[]> {
    return this.db.exec(`SELECT data FROM runs ORDER BY created_at ASC`).map((r) => parseJson<PlanningRun>(r.data, undefined as never))
  }

  // ---- coordinator-only credential references ---------------------------------------

  async setRunCredentials(runId: string, credentials: AgentCredential[]): Promise<void> {
    requireRun(this.db, runId)
    for (const c of credentials) {
      this.db.exec(
        `INSERT INTO run_credentials (run_id, user_id, agent_name, api_token) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id, user_id) DO UPDATE SET agent_name = excluded.agent_name, api_token = excluded.api_token`,
        runId, c.userId, c.agentName, c.apiToken,
      )
    }
  }

  /** Coordinator-only. The API must never call this. */
  async getRunCredentials(runId: string): Promise<AgentCredential[]> {
    return this.db.exec(`SELECT user_id, agent_name, api_token FROM run_credentials WHERE run_id = ?`, runId).map((r) => ({
      userId: text(r.user_id)!,
      agentName: text(r.agent_name)!,
      apiToken: text(r.api_token)!,
    }))
  }

  // ---- optional webhook ----------------------------------------------------------------

  async enqueueWebhook(delivery: WebhookDelivery): Promise<void> {
    await this.db.transaction(async () => {
      this.db.exec(
        `INSERT INTO webhook_deliveries (event_id, run_id, data, status, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
        delivery.eventId, delivery.runId, json(delivery), delivery.status, delivery.createdAt,
      )
      insertPlanningTask(this.db, delivery.runId, "deliver_webhook", { eventId: delivery.eventId }, delivery.createdAt)
    })
  }

  async getWebhook(eventId: string): Promise<WebhookDelivery | null> {
    const row = this.db.exec(`SELECT data FROM webhook_deliveries WHERE event_id = ?`, eventId)[0]
    return row ? parseJson<WebhookDelivery>(row.data, undefined as never) : null
  }

  async updateWebhook(delivery: WebhookDelivery): Promise<void> {
    this.db.exec(`UPDATE webhook_deliveries SET data = ?, status = ? WHERE event_id = ?`, json(delivery), delivery.status, delivery.eventId)
  }

  // ---- private (async: the runtime requires every class method to be async) ----------

  private async enqueueRunLocked(now: string, snapshots: RunParticipantSnapshot[]): Promise<string> {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "")}`
    const run: PlanningRun = {
      runId,
      tripId: this.id,
      status: "queued",
      tripVersion: this.trip!.version,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      inputRevision: inputRevision(this.trip!, snapshots),
      participants: snapshots,
      limits: this.defaultLimits,
      captureStatus: "pending",
      relay: { workspaceRef: this.relayWorkspaceRef },
      missingResponses: [],
      modelCalls: 0,
      totalTokens: 0,
      currentRound: 0,
      createdAt: now,
    }
    insertRun(this.db, run)
    insertPlanningTask(this.db, runId, "start_run", {}, now)
    this.activeRunId = runId
    return runId
  }

  private async applyStaleLocked(run: PlanningRun, reason: string, now: string): Promise<void> {
    saveRun(this.db, { ...run, status: "stale", staleReason: reason, finishedAt: now })
    markRunTasksStale(this.db, run.runId, now)
    if (this.activeRunId === run.runId) this.activeRunId = undefined
  }
}

function allReady(trip: Trip | undefined, readiness: Record<string, ParticipantReadiness>): boolean {
  if (!trip) return false
  return trip.participantIds.every((id) => readiness[id]?.ready === true)
}

function inputRevision(trip: Trip, snapshots: RunParticipantSnapshot[]): string {
  const parts = [...snapshots].sort((a, b) => a.userId.localeCompare(b.userId)).map((s) => `${s.userId}:${s.profileVersion}`)
  return `trip${trip.version}|schema${PROFILE_SCHEMA_VERSION}|${parts.join(",")}`
}
