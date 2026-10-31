import { z } from "zod"
import { actorIdSchema, isoDate, isoDateTime } from "./ids.js"
import { tripRequirementsSchema } from "./profile.js"
import { taskStatusSchema } from "./onboarding.js"

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "needs_input",
  "failed",
  "cancelled",
  "stale",
])
export type RunStatus = z.infer<typeof runStatusSchema>
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "needs_input", "failed", "cancelled", "stale"]

export const captureStatusSchema = z.enum(["pending", "partial", "complete"])
export type CaptureStatus = z.infer<typeof captureStatusSchema>

export const runLimitsSchema = z.object({
  maxRounds: z.number().int().positive().default(3),
  deadlineMs: z.number().int().positive().default(5 * 60_000),
  maxModelCalls: z.number().int().positive().default(40),
  maxTotalTokens: z.number().int().positive().default(400_000),
})
export type RunLimits = z.infer<typeof runLimitsSchema>

export const COST_LABEL = "unverified estimate" as const

export const itineraryItemSchema = z.object({
  day: isoDate,
  startTime: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(60),
  description: z.string().max(2000).optional(),
  estimatedCostMinor: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  /** Always "unverified estimate" unless a live source supplied it (none in this draft). */
  costLabel: z.literal(COST_LABEL).default(COST_LABEL),
})
export type ItineraryItem = z.infer<typeof itineraryItemSchema>

export const proposalSchema = z.object({
  proposalId: z.string().min(1),
  byUserId: actorIdSchema,
  round: z.number().int().positive(),
  title: z.string().min(1).max(200),
  items: z.array(itineraryItemSchema).min(1),
  notes: z.string().max(4000).optional(),
  createdAt: isoDateTime,
})
export type Proposal = z.infer<typeof proposalSchema>

export const evaluationSchema = z.object({
  byUserId: actorIdSchema,
  proposalId: z.string().min(1),
  round: z.number().int().positive(),
  verdict: z.enum(["accept", "accept_with_changes", "reject"]),
  hardConstraintViolations: z.array(z.string().max(500)),
  concerns: z.array(z.string().max(500)),
  /** Constraints the agent could not verify (e.g. missing cost data). */
  uncertain: z.array(z.string().max(500)),
  createdAt: isoDateTime,
})
export type Evaluation = z.infer<typeof evaluationSchema>

export const itinerarySchema = z.object({
  assembledByUserId: actorIdSchema,
  days: z.array(z.object({ date: isoDate, items: z.array(itineraryItemSchema) })),
  notes: z.string().max(4000).optional(),
  /** Proposal IDs the itinerary was assembled from. */
  sourceProposalIds: z.array(z.string()),
})
export type Itinerary = z.infer<typeof itinerarySchema>

export const conflictSchema = z.object({
  topic: z.string().min(1).max(200),
  participantIds: z.array(actorIdSchema),
  description: z.string().max(2000),
  options: z.array(z.string().max(500)).optional(),
})
export type Conflict = z.infer<typeof conflictSchema>

export const runResultSchema = z.object({
  summary: z.string(),
  itinerary: itinerarySchema.optional(),
  conflicts: z.array(conflictSchema),
  /** Backend-computed check of the itinerary against supported hard constraints. */
  constraintReport: z.array(
    z.object({ userId: actorIdSchema, check: z.string(), outcome: z.enum(["ok", "violated", "unverified"]), detail: z.string().optional() }),
  ),
})
export type RunResult = z.infer<typeof runResultSchema>

export const runParticipantSnapshotSchema = z.object({
  userId: actorIdSchema,
  profileVersion: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  requirements: tripRequirementsSchema,
  /** Relay agent handle for this participant's personal agent, once registered. */
  agentName: z.string().optional(),
})
export type RunParticipantSnapshot = z.infer<typeof runParticipantSnapshotSchema>

export const planningRunSchema = z.object({
  runId: z.string().min(1),
  tripId: actorIdSchema,
  status: runStatusSchema,
  tripVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  /** Hash of (tripVersion, sorted participant profile versions). Deduplicates start triggers. */
  inputRevision: z.string().min(1),
  participants: z.array(runParticipantSnapshotSchema),
  limits: runLimitsSchema,
  captureStatus: captureStatusSchema,
  /** Public references only (no tokens). */
  relay: z
    .object({ workspaceRef: z.string().optional(), channelName: z.string().optional(), channelId: z.string().optional() })
    .default({}),
  /** Participant agents that produced no response within the limits. A missing response is not agreement. */
  missingResponses: z.array(actorIdSchema).default([]),
  modelCalls: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  currentRound: z.number().int().nonnegative().default(0),
  result: runResultSchema.optional(),
  failure: z.string().optional(),
  staleReason: z.string().optional(),
  replacedByRunId: z.string().optional(),
  createdAt: isoDateTime,
  startedAt: isoDateTime.optional(),
  finishedAt: isoDateTime.optional(),
})
export type PlanningRun = z.infer<typeof planningRunSchema>

export const planningTaskKindSchema = z.enum(["start_run", "run_round", "finalize_run", "deliver_webhook"])
export const planningTaskSchema = z.object({
  taskId: z.string().min(1),
  tripId: actorIdSchema,
  runId: z.string().min(1),
  kind: planningTaskKindSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  status: taskStatusSchema,
  attempts: z.number().int().nonnegative(),
  leaseUntil: isoDateTime.optional(),
  claimedBy: z.string().optional(),
  error: z.string().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})
export type PlanningTask = z.infer<typeof planningTaskSchema>

export const transcriptMessageSchema = z.object({
  id: z.string().min(1),
  relayMessageId: z.string().min(1),
  tripId: actorIdSchema,
  runId: z.string().min(1),
  /** Assigned by our recorder; capture order, not proof of causality. */
  sequence: z.number().int().nonnegative(),
  senderAgentId: z.string().min(1),
  representedUserId: actorIdSchema.optional(),
  channelId: z.string().min(1),
  replyToMessageId: z.string().optional(),
  sentAt: isoDateTime,
  recordedAt: isoDateTime,
  text: z.string(),
})
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>

/** Recorder input: everything except our own id/sequence/recordedAt. */
export const transcriptCaptureSchema = transcriptMessageSchema.omit({ id: true, sequence: true, recordedAt: true })
export type TranscriptCapture = z.infer<typeof transcriptCaptureSchema>

/** Validated output of one personal-agent model turn. */
export const personalAgentTurnOutputSchema = z.object({
  /** Text to post in the shared planning channel. Empty string = stay silent. */
  message: z.string().max(4000),
  proposal: proposalSchema.omit({ proposalId: true, byUserId: true, round: true, createdAt: true }).optional(),
  evaluations: z.array(evaluationSchema.omit({ byUserId: true, round: true, createdAt: true })).optional(),
  itinerary: itinerarySchema.omit({ assembledByUserId: true }).optional(),
  conflicts: z.array(conflictSchema).optional(),
})
export type PersonalAgentTurnOutput = z.infer<typeof personalAgentTurnOutputSchema>

export const webhookDeliverySchema = z.object({
  eventId: z.string().min(1),
  tripId: actorIdSchema,
  runId: z.string().min(1),
  status: z.enum(["pending", "sent", "failed"]),
  attempts: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  lastError: z.string().optional(),
  createdAt: isoDateTime,
  sentAt: isoDateTime.optional(),
})
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>

/** Context the runner gives a personal agent for one turn. Never includes other users' raw onboarding text. */
export const personalTurnPhaseSchema = z.enum(["propose", "evaluate", "assemble", "respond"])
export type PersonalTurnPhase = z.infer<typeof personalTurnPhaseSchema>

export const personalTurnContextSchema = z.object({
  phase: personalTurnPhaseSchema,
  round: z.number().int().nonnegative(),
  runId: z.string().min(1),
  trip: z.object({
    tripId: actorIdSchema,
    title: z.string(),
    city: z.string(),
    dateRange: z.object({ start: z.string(), end: z.string() }),
    timezone: z.string(),
    context: z.string().optional(),
  }),
  self: z.object({ userId: actorIdSchema, agentName: z.string(), requirements: tripRequirementsSchema }),
  participants: z.array(z.object({ userId: actorIdSchema, agentName: z.string() })),
  proposals: z.array(proposalSchema),
  evaluations: z.array(evaluationSchema),
  /** Shared channel history so far (what every agent can see). */
  history: z.array(z.object({ senderAgentId: z.string(), text: z.string() })),
  incoming: z.object({ fromAgent: z.string(), text: z.string() }).optional(),
})
export type PersonalTurnContext = z.infer<typeof personalTurnContextSchema>
