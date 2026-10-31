import { Actor, type ActorContext } from "durable-actors"
import { ensureTables, text } from "./sql.js"

export interface Wakeup {
  wakeupId: string
  kind: "user" | "trip"
  /** userId for kind=user, tripId for kind=trip. */
  id: string
  /** tripId associated with a user wakeup, when known. */
  tripId?: string
  createdAt: string
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS trips (trip_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS trip_members (trip_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (trip_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS wakeups (
    wakeup_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    trip_id TEXT,
    status TEXT NOT NULL,
    lease_until TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS wakeups_pending ON wakeups (status, created_at)`,
]

/**
 * RegistryActor("global"): the coordinator cannot enumerate actors, so the API
 * registers every trip and user here and enqueues wakeups whenever it creates work.
 * The coordinator drains wakeups and also sweeps all registered ids periodically,
 * so a lost wakeup only delays recovery instead of losing the task.
 */
export class RegistryActor extends Actor {
  constructor(context: ActorContext) {
    super(context)
    ensureTables(this.db, TABLES)
  }

  async registerTrip(tripId: string, participantIds: string[]): Promise<void> {
    const now = new Date().toISOString()
    await this.db.transaction(async () => {
      this.db.exec(`INSERT INTO trips (trip_id, created_at) VALUES (?, ?) ON CONFLICT(trip_id) DO NOTHING`, tripId, now)
      for (const userId of participantIds) {
        this.db.exec(`INSERT INTO users (user_id, created_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING`, userId, now)
        this.db.exec(`INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, tripId, userId)
      }
    })
  }

  async enqueueWakeup(kind: "user" | "trip", id: string, tripId?: string): Promise<string> {
    const now = new Date().toISOString()
    const wakeupId = `wk_${crypto.randomUUID().replace(/-/g, "")}`
    this.db.exec(
      `INSERT INTO wakeups (wakeup_id, kind, id, trip_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      wakeupId, kind, id, tripId ?? null, now,
    )
    return wakeupId
  }

  /** Claims up to `limit` pending wakeups with a lease. */
  async claimWakeups(workerId: string, limit: number, leaseMs: number): Promise<Wakeup[]> {
    const now = new Date()
    const nowIso = now.toISOString()
    const rows = this.db.exec(
      `SELECT * FROM wakeups WHERE status = 'pending' OR (status = 'claimed' AND lease_until < ?) ORDER BY created_at ASC LIMIT ?`,
      nowIso, limit,
    )
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
    const claimed: Wakeup[] = []
    for (const r of rows) {
      const wakeupId = text(r.wakeup_id)!
      this.db.exec(`UPDATE wakeups SET status = 'claimed', lease_until = ? WHERE wakeup_id = ?`, leaseUntil, wakeupId)
      claimed.push({ wakeupId, kind: r.kind as Wakeup["kind"], id: text(r.id)!, tripId: text(r.trip_id), createdAt: text(r.created_at)! })
    }
    void workerId
    return claimed
  }

  async completeWakeup(wakeupId: string): Promise<void> {
    this.db.exec(`DELETE FROM wakeups WHERE wakeup_id = ?`, wakeupId)
  }

  async listTrips(): Promise<string[]> {
    return this.db.exec<{ trip_id: string }>(`SELECT trip_id FROM trips ORDER BY created_at ASC`).map((r) => r.trip_id)
  }

  async listTripMembers(tripId: string): Promise<string[]> {
    return this.db.exec<{ user_id: string }>(`SELECT user_id FROM trip_members WHERE trip_id = ?`, tripId).map((r) => r.user_id)
  }

  async listUsers(): Promise<string[]> {
    return this.db.exec<{ user_id: string }>(`SELECT user_id FROM users ORDER BY created_at ASC`).map((r) => r.user_id)
  }
}
