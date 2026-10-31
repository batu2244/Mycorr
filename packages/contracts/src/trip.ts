import { z } from "zod"
import { actorIdSchema, isoDate, isoDateTime } from "./ids.js"

export const dateRangeSchema = z
  .object({ start: isoDate, end: isoDate })
  .refine((r) => r.start <= r.end, { message: "date range end must not be before start" })
export type DateRange = z.infer<typeof dateRangeSchema>

export const tripSchema = z.object({
  tripId: actorIdSchema,
  title: z.string().min(1).max(200),
  city: z.string().min(1).max(200),
  dateRange: dateRangeSchema,
  /** IANA timezone used to interpret the date range (defaults to UTC if the creator gave none). */
  timezone: z.string().min(1),
  context: z.string().max(4000).optional(),
  creatorId: actorIdSchema,
  participantIds: z.array(actorIdSchema).min(1),
  /** Bumps when participants or context change. A run is tied to one trip version. */
  version: z.number().int().positive(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})
export type Trip = z.infer<typeof tripSchema>

export const createTripInputSchema = z.object({
  title: z.string().min(1).max(200),
  city: z.string().min(1).max(200),
  dateRange: dateRangeSchema,
  timezone: z.string().min(1).default("UTC"),
  context: z.string().max(4000).optional(),
  participantIds: z.array(actorIdSchema).min(1),
})
export type CreateTripInput = z.infer<typeof createTripInputSchema>

export const participantReadinessSchema = z.object({
  userId: actorIdSchema,
  ready: z.boolean(),
  profileVersion: z.number().int().nonnegative().optional(),
  schemaVersion: z.number().int().positive().optional(),
  updatedAt: isoDateTime.optional(),
})
export type ParticipantReadiness = z.infer<typeof participantReadinessSchema>

/** Delivered from UserActor outbox to TripActor by the coordinator. Idempotent on eventId. */
export const readinessNotificationSchema = z.object({
  eventId: z.string().min(1),
  userId: actorIdSchema,
  tripId: actorIdSchema,
  ready: z.boolean(),
  profileVersion: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  occurredAt: isoDateTime,
})
export type ReadinessNotification = z.infer<typeof readinessNotificationSchema>

/** Days covered by the trip, inclusive. */
export function tripDayCount(range: DateRange): number {
  const start = Date.parse(`${range.start}T00:00:00Z`)
  const end = Date.parse(`${range.end}T00:00:00Z`)
  return Math.round((end - start) / 86_400_000) + 1
}
