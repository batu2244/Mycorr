import { z } from "zod"
import { actorIdSchema, isoDateTime } from "./ids.js"
import { fieldKeySchema, fieldStatusSchema, tripRequirementsSchema } from "./profile.js"

export const onboardingRoleSchema = z.enum(["user", "assistant", "system"])

export const onboardingMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  tripId: actorIdSchema,
  clientMessageId: z.string().min(1).optional(),
  role: onboardingRoleSchema,
  text: z.string(),
  createdAt: isoDateTime,
  /** Per-session capture order. */
  sequence: z.number().int().nonnegative(),
  /** Input version of the session when this message was recorded. */
  inputVersion: z.number().int().nonnegative(),
})
export type OnboardingMessage = z.infer<typeof onboardingMessageSchema>

export const onboardingSessionStatusSchema = z.enum(["active", "ready"])

export const onboardingSessionSchema = z.object({
  sessionId: z.string().min(1),
  tripId: actorIdSchema,
  userId: actorIdSchema,
  status: onboardingSessionStatusSchema,
  /** Increments on every stored user message. Tasks carry the version they processed. */
  inputVersion: z.number().int().nonnegative(),
  missingFields: z.array(fieldKeySchema),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})
export type OnboardingSession = z.infer<typeof onboardingSessionSchema>

export const taskStatusSchema = z.enum(["pending", "claimed", "done", "failed", "stale"])
export type TaskStatus = z.infer<typeof taskStatusSchema>

export const questionTaskSchema = z.object({
  taskId: z.string().min(1),
  userId: actorIdSchema,
  tripId: actorIdSchema,
  sessionId: z.string().min(1),
  status: taskStatusSchema,
  attempts: z.number().int().nonnegative(),
  /** Session input version this task is expected to process. */
  inputVersion: z.number().int().nonnegative(),
  leaseUntil: isoDateTime.optional(),
  claimedBy: z.string().optional(),
  error: z.string().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})
export type QuestionTask = z.infer<typeof questionTaskSchema>

export const onboardingMessageInputSchema = z.object({
  clientMessageId: z.string().min(1).max(200),
  text: z.string().min(1).max(8000),
})
export type OnboardingMessageInput = z.infer<typeof onboardingMessageInputSchema>

/** One field update proposed by the question agent. Status cannot be set to `missing` by the model. */
export const fieldPatchSchema = z.object({
  status: fieldStatusSchema.exclude(["missing"]),
  value: z.unknown().optional(),
  note: z.string().max(1000).optional(),
})

export const profilePatchSchema = z.object({
  fields: z.partialRecord(fieldKeySchema, fieldPatchSchema),
})
export type ProfilePatch = z.infer<typeof profilePatchSchema>

/** Validated model output for one question-agent turn. */
export const questionAgentOutputSchema = z.object({
  patch: profilePatchSchema,
  next: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("question"), text: z.string().min(1).max(2000) }),
    z.object({ kind: z.literal("complete"), text: z.string().max(2000).optional() }),
  ]),
})
export type QuestionAgentOutput = z.infer<typeof questionAgentOutputSchema>

/** What the coordinator hands to the question agent (never another user's data). */
export const questionAgentContextSchema = z.object({
  task: questionTaskSchema,
  session: onboardingSessionSchema,
  trip: z.object({
    tripId: actorIdSchema,
    title: z.string(),
    city: z.string(),
    dateRange: z.object({ start: z.string(), end: z.string() }),
    timezone: z.string(),
    context: z.string().optional(),
  }),
  requirements: tripRequirementsSchema,
  missingFields: z.array(fieldKeySchema),
  /** Full session history, oldest first. */
  messages: z.array(onboardingMessageSchema),
  /** IDs of user messages not yet reflected in the profile. */
  unprocessedMessageIds: z.array(z.string()),
})
export type QuestionAgentContext = z.infer<typeof questionAgentContextSchema>
