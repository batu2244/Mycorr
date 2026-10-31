import type { ActorDatabase } from "durable-actors"
import {
  PROFILE_SCHEMA_VERSION,
  type FieldKey,
  type GeneralProfile,
  type OnboardingMessage,
  type OnboardingSession,
  type QuestionTask,
  type TripRequirements,
} from "@mycorr/contracts"
import { int, json, parseJson } from "./sql.js"

/** Row-level helpers for UserActor. Plain functions because actor class methods must all be async. */

type Row = Record<string, string | number | bigint | Uint8Array | null>

export function sessionForTrip(db: ActorDatabase, userId: string, tripId: string): OnboardingSession | undefined {
  const row = db.exec(`SELECT * FROM onboarding_sessions WHERE trip_id = ?`, tripId)[0]
  return row ? rowToSession(row as Row, userId) : undefined
}

export function sessionById(db: ActorDatabase, userId: string, sessionId: string): OnboardingSession | undefined {
  const row = db.exec(`SELECT * FROM onboarding_sessions WHERE session_id = ?`, sessionId)[0]
  return row ? rowToSession(row as Row, userId) : undefined
}

export function rowToSession(r: Row, userId: string): OnboardingSession {
  return {
    sessionId: String(r.session_id),
    tripId: String(r.trip_id),
    userId,
    status: r.status as OnboardingSession["status"],
    inputVersion: Number(r.input_version),
    missingFields: parseJson<FieldKey[]>(r.missing_fields, []),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

export function rowToTask(r: Row, userId: string): QuestionTask {
  return {
    taskId: String(r.task_id),
    userId,
    tripId: String(r.trip_id),
    sessionId: String(r.session_id),
    status: r.status as QuestionTask["status"],
    attempts: Number(r.attempts),
    inputVersion: Number(r.input_version),
    leaseUntil: r.lease_until ? String(r.lease_until) : undefined,
    claimedBy: r.claimed_by ? String(r.claimed_by) : undefined,
    error: r.error ? String(r.error) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

export function messagesForSession(db: ActorDatabase, sessionId: string): OnboardingMessage[] {
  return db.exec(`SELECT * FROM onboarding_messages WHERE session_id = ? ORDER BY sequence ASC`, sessionId).map((row) => {
    const r = row as Row
    return {
      id: String(r.id),
      sessionId: String(r.session_id),
      tripId: String(r.trip_id),
      clientMessageId: r.client_message_id ? String(r.client_message_id) : undefined,
      role: r.role as OnboardingMessage["role"],
      text: String(r.text),
      createdAt: String(r.created_at),
      sequence: Number(r.sequence),
      inputVersion: Number(r.input_version),
    }
  })
}

export function unprocessedUserMessageIds(db: ActorDatabase, sessionId: string): string[] {
  return db
    .exec<{ id: string }>(`SELECT id FROM onboarding_messages WHERE session_id = ? AND role = 'user' AND processed = 0 ORDER BY sequence ASC`, sessionId)
    .map((r) => r.id)
}

export function nextSequence(db: ActorDatabase, sessionId: string): number {
  const row = db.exec(`SELECT COALESCE(MAX(sequence), -1) AS max_seq FROM onboarding_messages WHERE session_id = ?`, sessionId)[0]
  return int(row?.max_seq, -1) + 1
}

export function openTaskForSession(db: ActorDatabase, userId: string, sessionId: string): QuestionTask | undefined {
  const row = db.exec(
    `SELECT * FROM question_tasks WHERE session_id = ? AND status IN ('pending', 'claimed') ORDER BY created_at DESC LIMIT 1`,
    sessionId,
  )[0]
  return row ? rowToTask(row as Row, userId) : undefined
}

export function latestTaskForSession(db: ActorDatabase, userId: string, sessionId: string): QuestionTask | undefined {
  const row = db.exec(`SELECT * FROM question_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`, sessionId)[0]
  return row ? rowToTask(row as Row, userId) : undefined
}

export function insertTask(db: ActorDatabase, sessionId: string, tripId: string, inputVersion: number, now: string): string {
  const taskId = `qt_${crypto.randomUUID().replace(/-/g, "")}`
  db.exec(
    `INSERT INTO question_tasks (task_id, session_id, trip_id, status, attempts, input_version, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    taskId, sessionId, tripId, inputVersion, now, now,
  )
  return taskId
}

export function loadRequirements(db: ActorDatabase, tripId: string, general: GeneralProfile): TripRequirements {
  const row = db.exec(`SELECT * FROM trip_requirements WHERE trip_id = ?`, tripId)[0]
  if (!row) {
    // Seed trip requirements with reusable general preferences, if the user already stated them.
    const fields: TripRequirements["fields"] = {}
    if (general.preferences) fields.preferences = general.preferences
    return { schemaVersion: PROFILE_SCHEMA_VERSION, profileVersion: 0, fields }
  }
  const r = row as Row
  return {
    schemaVersion: Number(r.schema_version),
    profileVersion: Number(r.profile_version),
    fields: parseJson<TripRequirements["fields"]>(r.fields, {}),
  }
}

export function saveRequirements(db: ActorDatabase, tripId: string, requirements: TripRequirements, now: string): void {
  db.exec(
    `INSERT INTO trip_requirements (trip_id, schema_version, profile_version, fields, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(trip_id) DO UPDATE SET schema_version = excluded.schema_version, profile_version = excluded.profile_version, fields = excluded.fields, updated_at = excluded.updated_at`,
    tripId, requirements.schemaVersion, requirements.profileVersion, json(requirements.fields), now,
  )
}
