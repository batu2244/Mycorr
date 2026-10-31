import type { ActorDatabase } from "durable-actors"
import type { PlanningRun, PlanningTask } from "@mycorr/contracts"
import { int, json, parseJson } from "./sql.js"

/** Row-level helpers for TripActor. Plain functions because actor class methods must all be async. */

type Row = Record<string, string | number | bigint | Uint8Array | null>

export function insertPlanningTask(db: ActorDatabase, runId: string, kind: PlanningTask["kind"], payload: Record<string, unknown>, now: string): string {
  const taskId = `pt_${crypto.randomUUID().replace(/-/g, "")}`
  db.exec(
    `INSERT INTO planning_tasks (task_id, run_id, kind, payload, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    taskId, runId, kind, json(payload), now, now,
  )
  return taskId
}

export function rowToPlanningTask(r: Row, tripId: string): PlanningTask {
  return {
    taskId: String(r.task_id),
    tripId,
    runId: String(r.run_id),
    kind: r.kind as PlanningTask["kind"],
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    status: r.status as PlanningTask["status"],
    attempts: Number(r.attempts),
    leaseUntil: r.lease_until ? String(r.lease_until) : undefined,
    claimedBy: r.claimed_by ? String(r.claimed_by) : undefined,
    error: r.error ? String(r.error) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

export function loadRun(db: ActorDatabase, runId: string): PlanningRun | undefined {
  const row = db.exec(`SELECT data FROM runs WHERE run_id = ?`, runId)[0]
  return row ? parseJson<PlanningRun>(row.data, undefined as never) : undefined
}

export function requireRun(db: ActorDatabase, runId: string): PlanningRun {
  const run = loadRun(db, runId)
  if (!run) throw new Error(`unknown run ${runId}`)
  return run
}

export function saveRun(db: ActorDatabase, run: PlanningRun): void {
  db.exec(`UPDATE runs SET status = ?, data = ? WHERE run_id = ?`, run.status, json(run), run.runId)
}

export function insertRun(db: ActorDatabase, run: PlanningRun): void {
  db.exec(`INSERT INTO runs (run_id, status, input_revision, data, created_at) VALUES (?, ?, ?, ?, ?)`, run.runId, run.status, run.inputRevision, json(run), run.createdAt)
}

export function nextTranscriptSequence(db: ActorDatabase, runId: string): number {
  const row = db.exec(`SELECT COALESCE(MAX(sequence), -1) AS max_seq FROM transcript WHERE run_id = ?`, runId)[0]
  return int(row?.max_seq, -1) + 1
}

export function markRunTasksStale(db: ActorDatabase, runId: string, now: string): void {
  db.exec(`UPDATE planning_tasks SET status = 'stale', updated_at = ? WHERE run_id = ? AND status IN ('pending', 'claimed')`, now, runId)
}
