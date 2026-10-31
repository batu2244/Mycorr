import { z } from "zod"
import { actorIdSchema } from "./ids.js"
import { onboardingMessageSchema, onboardingSessionSchema, questionTaskSchema } from "./onboarding.js"
import { fieldKeySchema, tripRequirementsSchema } from "./profile.js"
import { participantReadinessSchema, tripSchema } from "./trip.js"
import { planningRunSchema, transcriptMessageSchema } from "./planning.js"

export const tripViewSchema = z.object({
  trip: tripSchema,
  readiness: z.array(participantReadinessSchema),
  activeRunId: z.string().optional(),
  runIds: z.array(z.string()),
})
export type TripView = z.infer<typeof tripViewSchema>

export const onboardingViewSchema = z.object({
  session: onboardingSessionSchema,
  messages: z.array(onboardingMessageSchema),
  requirements: tripRequirementsSchema,
  missingFields: z.array(fieldKeySchema),
  pendingTask: questionTaskSchema.optional(),
})
export type OnboardingView = z.infer<typeof onboardingViewSchema>

export const onboardingAcceptedSchema = z.object({
  messageId: z.string(),
  taskId: z.string(),
  deduplicated: z.boolean(),
})
export type OnboardingAccepted = z.infer<typeof onboardingAcceptedSchema>

export const runViewSchema = z.object({
  run: planningRunSchema,
  transcript: z.array(transcriptMessageSchema),
})
export type RunView = z.infer<typeof runViewSchema>

export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
export type ApiError = z.infer<typeof apiErrorSchema>

/** Identity resolved by the API from a server session or scoped agent token. Never from a body field. */
export const principalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: actorIdSchema }),
  z.object({
    kind: z.literal("agent"),
    role: z.enum(["question", "personal"]),
    userId: actorIdSchema,
    tripId: actorIdSchema,
    taskId: z.string().optional(),
    runId: z.string().optional(),
  }),
  z.object({ kind: z.literal("service"), name: z.string() }),
])
export type Principal = z.infer<typeof principalSchema>
