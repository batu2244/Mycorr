import { z } from "zod"

/** Actor IDs must be 1-128 ASCII letters, digits, dots, underscores, or hyphens (Durable Actors rule). */
export const actorIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u, "invalid id")

export const userIdSchema = actorIdSchema.brand<"UserId">()
export const tripIdSchema = actorIdSchema.brand<"TripId">()
export const runIdSchema = actorIdSchema.brand<"RunId">()
export const taskIdSchema = actorIdSchema.brand<"TaskId">()
export const messageIdSchema = actorIdSchema.brand<"MessageId">()

export type UserId = z.infer<typeof userIdSchema>
export type TripId = z.infer<typeof tripIdSchema>
export type RunId = z.infer<typeof runIdSchema>
export type TaskId = z.infer<typeof taskIdSchema>
export type MessageId = z.infer<typeof messageIdSchema>

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

export const isoDateTime = z.iso.datetime({ offset: true })
export const isoDate = z.iso.date()
export type IsoDateTime = z.infer<typeof isoDateTime>
export type IsoDate = z.infer<typeof isoDate>

export function nowIso(): string {
  return new Date().toISOString()
}
