import { Actor, Persisted, type ActorContext } from "durable-actors"
import {
  PROFILE_SCHEMA_VERSION,
  computeMissingFields,
  validateFieldValue,
  type FieldKey,
  type FieldState,
  type GeneralProfile,
  type OnboardingMessage,
  type OnboardingSession,
  type ProfilePatch,
  type QuestionAgentContext,
  type QuestionTask,
  type ReadinessNotification,
  type TripRequirements,
} from "@mycorr/contracts"
import { ensureTables, int, json, parseJson, text } from "./sql.js"
import {
  insertTask,
  latestTaskForSession,
  loadRequirements,
  messagesForSession,
  nextSequence,
  openTaskForSession,
  rowToTask,
  saveRequirements,
  sessionById,
  sessionForTrip,
  unprocessedUserMessageIds,
} from "./user-store.js"

export interface TripSummary {
  tripId: string
  title: string
  city: string
  dateRange: { start: string; end: string }
  timezone: string
  context?: string
}

export interface SubmitMessageResult {
  messageId: string
  taskId: string
  deduplicated: boolean
}

export interface OnboardingState {
  session: OnboardingSession
  messages: OnboardingMessage[]
  requirements: TripRequirements
  missingFields: FieldKey[]
  pendingTask: QuestionTask | null
}

export interface CompleteTaskInput {
  taskId: string
  /** Session input version the agent processed. Mismatch => result is stale and discarded. */
  inputVersion: number
  patch: ProfilePatch
  assistantText?: string
  processedMessageIds: string[]
}

export type CompleteTaskResult =
  | { outcome: "applied"; ready: boolean; missingFields: FieldKey[]; profileVersion: number; questionMessageId?: string; rejectedFields: string[] }
  | { outcome: "stale"; reason: string; nextTaskId?: string }
  | { outcome: "rejected"; reason: string }

export interface ProfileSnapshot {
  userId: string
  tripId: string
  schemaVersion: number
  profileVersion: number
  requirements: TripRequirements
  ready: boolean
}

export interface OutboxEvent {
  eventId: string
  kind: "readiness"
  payload: ReadinessNotification
  attempts: number
}

export interface VmSessionRef {
  role: "question" | "personal"
  tripId: string
  /** Provider identifiers only (sandbox id, session dir). Never a credential. */
  sandboxId?: string
  sessionDir?: string
  updatedAt: string
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS onboarding_sessions (
    session_id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    input_version INTEGER NOT NULL DEFAULT 0,
    missing_fields TEXT NOT NULL,
    trip_summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS onboarding_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    client_message_id TEXT,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    input_version INTEGER NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS onboarding_messages_client
     ON onboarding_messages (session_id, client_message_id) WHERE client_message_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS trip_requirements (
    trip_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    profile_version INTEGER NOT NULL,
    fields TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS question_tasks (
    task_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    input_version INTEGER NOT NULL,
    lease_until TEXT,
    claimed_by TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    event_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS vm_sessions (
    role TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    PRIMARY KEY (role, trip_id)
  )`,
]

/**
 * UserActor(userId): owns one person's private onboarding history, profile, and
 * question-agent tasks. No network or model calls happen here; the coordinator
 * claims tasks, does the slow work outside, and submits results with the input
 * version it processed.
 */
export class UserActor extends Actor {
  @Persisted private generalProfile: GeneralProfile = { schemaVersion: PROFILE_SCHEMA_VERSION, version: 0 }

  constructor(context: ActorContext) {
    super(context)
    ensureTables(this.db, TABLES)
  }

  // ---- onboarding lifecycle --------------------------------------------------

  async startOnboarding(trip: TripSummary): Promise<OnboardingSession> {
    const existing = sessionForTrip(this.db, this.id, trip.tripId)
    if (existing) return existing
    const now = new Date().toISOString()
    const sessionId = `ses_${crypto.randomUUID().replace(/-/g, "")}`
    const requirements = loadRequirements(this.db, trip.tripId, this.generalProfile)
    const missing = computeMissingFields(requirements)
    await this.db.transaction(async () => {
      this.db.exec(
        `INSERT INTO onboarding_sessions (session_id, trip_id, status, input_version, missing_fields, trip_summary, created_at, updated_at)
         VALUES (?, ?, 'active', 0, ?, ?, ?, ?)`,
        sessionId, trip.tripId, json(missing), json(trip), now, now,
      )
      saveRequirements(this.db, trip.tripId, requirements, now)
    })
    return sessionForTrip(this.db, this.id, trip.tripId)!
  }

  async getOnboarding(tripId: string): Promise<OnboardingState | null> {
    const session = sessionForTrip(this.db, this.id, tripId)
    if (!session) return null
    const requirements = loadRequirements(this.db, tripId, this.generalProfile)
    return {
      session,
      messages: messagesForSession(this.db, session.sessionId),
      requirements,
      missingFields: computeMissingFields(requirements),
      pendingTask: openTaskForSession(this.db, this.id, session.sessionId) ?? null,
    }
  }

  /** Persists the raw user message before any model work. Idempotent on clientMessageId. */
  async submitUserMessage(tripId: string, clientMessageId: string, messageText: string): Promise<SubmitMessageResult> {
    const session = sessionForTrip(this.db, this.id, tripId)
    if (!session) throw new Error(`no onboarding session for trip ${tripId}`)
    const dup = this.db.exec<{ id: string }>(
      `SELECT id FROM onboarding_messages WHERE session_id = ? AND client_message_id = ?`,
      session.sessionId, clientMessageId,
    )[0]
    if (dup) {
      const task = openTaskForSession(this.db, this.id, session.sessionId) ?? latestTaskForSession(this.db, this.id, session.sessionId)
      return { messageId: dup.id, taskId: task?.taskId ?? "", deduplicated: true }
    }
    const now = new Date().toISOString()
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`
    const nextVersion = session.inputVersion + 1
    let taskId = ""
    await this.db.transaction(async () => {
      const seq = nextSequence(this.db, session.sessionId)
      this.db.exec(
        `INSERT INTO onboarding_messages (id, session_id, trip_id, client_message_id, role, text, created_at, sequence, input_version, processed)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, 0)`,
        messageId, session.sessionId, tripId, clientMessageId, messageText, now, seq, nextVersion,
      )
      this.db.exec(`UPDATE onboarding_sessions SET input_version = ?, status = 'active', updated_at = ? WHERE session_id = ?`, nextVersion, now, session.sessionId)
      // One open task per session. A pending (unclaimed) task is retargeted to the new input
      // version so rapid messages merge; a claimed task is left alone and will be judged stale.
      const open = openTaskForSession(this.db, this.id, session.sessionId)
      if (open && open.status === "pending") {
        this.db.exec(`UPDATE question_tasks SET input_version = ?, updated_at = ? WHERE task_id = ?`, nextVersion, now, open.taskId)
        taskId = open.taskId
      } else if (open) {
        taskId = open.taskId
      } else {
        taskId = insertTask(this.db, session.sessionId, tripId, nextVersion, now)
      }
    })
    return { messageId, taskId, deduplicated: false }
  }

  // ---- task queue (claim / complete / fail) ---------------------------------

  /** Claims the next pending (or lease-expired) task with a lease. Returns the full agent context. */
  async claimQuestionTask(workerId: string, leaseMs: number): Promise<QuestionAgentContext | null> {
    const now = new Date()
    const nowIso = now.toISOString()
    const row = this.db.exec(
      `SELECT * FROM question_tasks
        WHERE status = 'pending' OR (status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?)
        ORDER BY created_at ASC LIMIT 1`,
      nowIso,
    )[0]
    if (!row) return null
    const task = rowToTask(row, this.id)
    const session = sessionById(this.db, this.id, task.sessionId)
    if (!session) {
      this.db.exec(`UPDATE question_tasks SET status = 'failed', error = 'session missing', updated_at = ? WHERE task_id = ?`, nowIso, task.taskId)
      return null
    }
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
    this.db.exec(
      `UPDATE question_tasks SET status = 'claimed', attempts = attempts + 1, lease_until = ?, claimed_by = ?, input_version = ?, updated_at = ? WHERE task_id = ?`,
      leaseUntil, workerId, session.inputVersion, nowIso, task.taskId,
    )
    const requirements = loadRequirements(this.db, task.tripId, this.generalProfile)
    const tripRow = this.db.exec<{ trip_summary: string }>(`SELECT trip_summary FROM onboarding_sessions WHERE session_id = ?`, session.sessionId)[0]
    const trip = parseJson<TripSummary>(tripRow?.trip_summary, { tripId: task.tripId, title: "", city: "", dateRange: { start: "", end: "" }, timezone: "UTC" })
    return {
      task: { ...task, status: "claimed", attempts: task.attempts + 1, leaseUntil, claimedBy: workerId, inputVersion: session.inputVersion },
      session,
      trip,
      requirements,
      missingFields: computeMissingFields(requirements),
      messages: messagesForSession(this.db, session.sessionId),
      unprocessedMessageIds: unprocessedUserMessageIds(this.db, session.sessionId),
    }
  }

  /**
   * Applies a validated agent result. Backend rules decide readiness; the model's
   * "complete" claim is ignored. Stale results (input version moved on) are discarded
   * and a fresh task is queued so the newer input gets processed.
   */
  async completeQuestionTask(input: CompleteTaskInput): Promise<CompleteTaskResult> {
    const row = this.db.exec(`SELECT * FROM question_tasks WHERE task_id = ?`, input.taskId)[0]
    if (!row) return { outcome: "rejected", reason: "unknown task" }
    const task = rowToTask(row, this.id)
    if (task.status !== "claimed") return { outcome: "rejected", reason: `task is ${task.status}` }
    const session = sessionById(this.db, this.id, task.sessionId)
    if (!session) return { outcome: "rejected", reason: "session missing" }
    const now = new Date().toISOString()

    if (session.inputVersion !== input.inputVersion) {
      let nextTaskId: string | undefined
      await this.db.transaction(async () => {
        this.db.exec(`UPDATE question_tasks SET status = 'stale', updated_at = ? WHERE task_id = ?`, now, task.taskId)
        nextTaskId = insertTask(this.db, session.sessionId, task.tripId, session.inputVersion, now)
      })
      return { outcome: "stale", reason: `input version ${input.inputVersion} != ${session.inputVersion}`, nextTaskId }
    }

    const requirements = loadRequirements(this.db, task.tripId, this.generalProfile)
    const supporting = input.processedMessageIds
    const nextFields: Partial<Record<FieldKey, FieldState>> = { ...requirements.fields }
    const rejectedFields: string[] = []
    for (const [key, patch] of Object.entries(input.patch.fields) as [FieldKey, ProfilePatch["fields"][FieldKey]][]) {
      if (!patch) continue
      if (patch.status === "answered") {
        const check = validateFieldValue(key, patch.value)
        if (!check.ok) {
          rejectedFields.push(`${key}: ${check.error}`)
          continue
        }
        nextFields[key] = { status: "answered", value: check.value, supportingAnswerIds: supporting, note: patch.note, updatedAt: now }
      } else {
        nextFields[key] = {
          status: "needs_clarification",
          value: nextFields[key]?.value,
          supportingAnswerIds: supporting,
          note: patch.note ?? "needs clarification",
          updatedAt: now,
        }
      }
    }
    const nextRequirements: TripRequirements = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profileVersion: requirements.profileVersion + 1,
      fields: nextFields,
    }
    const missing = computeMissingFields(nextRequirements)
    const ready = missing.length === 0
    let questionMessageId: string | undefined

    await this.db.transaction(async () => {
      saveRequirements(this.db, task.tripId, nextRequirements, now)
      // General (reusable) preferences live on the user, not the trip.
      const prefs = nextFields.preferences
      if (prefs && prefs.status === "answered") {
        this.generalProfile = { schemaVersion: PROFILE_SCHEMA_VERSION, version: this.generalProfile.version + 1, preferences: prefs }
      }
      for (const id of supporting) this.db.exec(`UPDATE onboarding_messages SET processed = 1 WHERE id = ?`, id)
      if (input.assistantText && input.assistantText.trim().length > 0) {
        questionMessageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`
        this.db.exec(
          `INSERT INTO onboarding_messages (id, session_id, trip_id, client_message_id, role, text, created_at, sequence, input_version, processed)
           VALUES (?, ?, ?, NULL, 'assistant', ?, ?, ?, ?, 1)`,
          questionMessageId, session.sessionId, task.tripId, input.assistantText, now, nextSequence(this.db, session.sessionId), session.inputVersion,
        )
      }
      this.db.exec(
        `UPDATE onboarding_sessions SET status = ?, missing_fields = ?, updated_at = ? WHERE session_id = ?`,
        ready ? "ready" : "active", json(missing), now, session.sessionId,
      )
      this.db.exec(
        `UPDATE question_tasks SET status = 'done', error = ?, updated_at = ? WHERE task_id = ?`,
        rejectedFields.length ? `rejected fields: ${rejectedFields.join(" | ")}` : null, now, task.taskId,
      )
      // Readiness notification is persisted atomically with the profile update.
      const notification: ReadinessNotification = {
        eventId: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
        userId: this.id,
        tripId: task.tripId,
        ready,
        profileVersion: nextRequirements.profileVersion,
        schemaVersion: nextRequirements.schemaVersion,
        occurredAt: now,
      }
      this.db.exec(
        `INSERT INTO outbox (event_id, kind, payload, status, attempts, created_at) VALUES (?, 'readiness', ?, 'pending', 0, ?)`,
        notification.eventId, json(notification), now,
      )
    })
    return { outcome: "applied", ready, missingFields: missing, profileVersion: nextRequirements.profileVersion, questionMessageId, rejectedFields }
  }

  async failQuestionTask(taskId: string, error: string, retry: boolean): Promise<void> {
    const now = new Date().toISOString()
    this.db.exec(
      `UPDATE question_tasks SET status = ?, error = ?, lease_until = NULL, updated_at = ? WHERE task_id = ? AND status = 'claimed'`,
      retry ? "pending" : "failed", error, now, taskId,
    )
  }

  // ---- outbox (readiness notifications) --------------------------------------

  async pendingOutbox(limit: number): Promise<OutboxEvent[]> {
    return this.db
      .exec(`SELECT event_id, kind, payload, attempts FROM outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`, limit)
      .map((r) => ({
        eventId: text(r.event_id)!,
        kind: "readiness" as const,
        payload: parseJson<ReadinessNotification>(r.payload, undefined as never),
        attempts: int(r.attempts),
      }))
  }

  async markOutboxDelivered(eventId: string): Promise<void> {
    this.db.exec(`UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE event_id = ?`, new Date().toISOString(), eventId)
  }

  async markOutboxAttempt(eventId: string): Promise<void> {
    this.db.exec(`UPDATE outbox SET attempts = attempts + 1 WHERE event_id = ?`, eventId)
  }

  // ---- read models for planning ---------------------------------------------

  /** Structured profile only. Raw onboarding messages are never returned here. */
  async getProfileSnapshot(tripId: string): Promise<ProfileSnapshot | null> {
    const session = sessionForTrip(this.db, this.id, tripId)
    if (!session) return null
    const requirements = loadRequirements(this.db, tripId, this.generalProfile)
    return {
      userId: this.id,
      tripId,
      schemaVersion: requirements.schemaVersion,
      profileVersion: requirements.profileVersion,
      requirements,
      ready: computeMissingFields(requirements).length === 0,
    }
  }

  async getGeneralProfile(): Promise<GeneralProfile> {
    return this.generalProfile
  }

  async setVmSession(ref: VmSessionRef): Promise<void> {
    this.db.exec(
      `INSERT INTO vm_sessions (role, trip_id, ref) VALUES (?, ?, ?) ON CONFLICT(role, trip_id) DO UPDATE SET ref = excluded.ref`,
      ref.role, ref.tripId, json(ref),
    )
  }

  async getVmSession(role: "question" | "personal", tripId: string): Promise<VmSessionRef | null> {
    const row = this.db.exec(`SELECT ref FROM vm_sessions WHERE role = ? AND trip_id = ?`, role, tripId)[0]
    return row ? parseJson<VmSessionRef>(row.ref, undefined as never) : null
  }
}
