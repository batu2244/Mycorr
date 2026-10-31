import type { ActorDatabase, SqliteValue } from "durable-actors"

/** Runs each statement once; used in actor constructors. */
export function ensureTables(db: ActorDatabase, statements: readonly string[]): void {
  for (const statement of statements) db.exec(statement)
}

export function json(value: unknown): string {
  return JSON.stringify(value)
}

export function parseJson<T>(value: SqliteValue | undefined, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback
  return JSON.parse(value) as T
}

export function text(value: SqliteValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function int(value: SqliteValue | undefined, fallback = 0): number {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  return fallback
}
