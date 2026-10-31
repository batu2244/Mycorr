import { z } from "zod"
import { isoDateTime } from "./ids.js"

/**
 * Versioned profile schema. Adding a required field = bump PROFILE_SCHEMA_VERSION
 * and add an entry to REQUIRED_FIELDS. Existing answers are never erased; the
 * completeness check simply reports the new field as `missing`.
 */
export const PROFILE_SCHEMA_VERSION = 1

export const fieldStatusSchema = z.enum(["missing", "answered", "needs_clarification"])
export type FieldStatus = z.infer<typeof fieldStatusSchema>

// ---- Field value types -------------------------------------------------------

export const availabilityWindowSchema = z.object({
  start: isoDateTime,
  end: isoDateTime,
})

export const availabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("whole_range") }),
  z.object({
    kind: z.literal("windows"),
    timezone: z.string().min(1),
    windows: z.array(availabilityWindowSchema).min(1),
  }),
])
export type Availability = z.infer<typeof availabilitySchema>

export const flexibilitySchema = z.object({
  negotiable: z.array(z.string().min(1)),
  fixed: z.array(z.string().min(1)),
  notes: z.string().optional(),
})
export type Flexibility = z.infer<typeof flexibilitySchema>

export const budgetScopeSchema = z.enum([
  "all",
  "excluding_lodging",
  "food",
  "activities",
  "lodging",
  "other",
])
export const budgetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_limit") }),
  z.object({
    kind: z.literal("amount"),
    /** Integer minor units (cents). */
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().length(3).toUpperCase(),
    scope: budgetScopeSchema,
    firmness: z.enum(["firm", "flexible"]),
  }),
])
export type Budget = z.infer<typeof budgetSchema>

export const SEED_PREFERENCE_CATEGORIES = ["food", "nature", "museums", "restaurants", "bars"] as const
export const preferenceItemSchema = z.object({
  /** Seeded with food/nature/museums/restaurants/bars; any other string is allowed. */
  category: z.string().min(1),
  detail: z.string().optional(),
})
export const preferencesSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_preference") }),
  z.object({
    kind: z.literal("stated"),
    interests: z.array(preferenceItemSchema),
    dislikes: z.array(preferenceItemSchema),
    priorities: z.array(z.string().min(1)),
  }),
])
export type Preferences = z.infer<typeof preferencesSchema>

// ---- Field registry ---------------------------------------------------------

export const FIELD_KEYS = ["availability", "flexibility", "dailyBudget", "totalBudget", "preferences"] as const
export const fieldKeySchema = z.enum(FIELD_KEYS)
export type FieldKey = z.infer<typeof fieldKeySchema>

export const fieldValueSchemas = {
  availability: availabilitySchema,
  flexibility: flexibilitySchema,
  dailyBudget: budgetSchema,
  totalBudget: budgetSchema,
  preferences: preferencesSchema,
} as const satisfies Record<FieldKey, z.ZodType>

export type FieldValueMap = { [K in FieldKey]: z.infer<(typeof fieldValueSchemas)[K]> }
export type FieldValue = FieldValueMap[FieldKey]

export interface RequiredFieldSpec {
  key: FieldKey
  /** Trip-specific fields live under tripId; general fields are reusable across trips. */
  scope: "trip" | "general"
  description: string
  completionRule: string
}

export const REQUIRED_FIELDS: readonly RequiredFieldSpec[] = [
  {
    key: "availability",
    scope: "trip",
    description: "When the person is available inside the trip date range, with timezone.",
    completionRule:
      "Concrete windows inside the trip date range, or an explicit statement that the whole range works.",
  },
  {
    key: "flexibility",
    scope: "trip",
    description: "What may change (schedule, spending, activities) and any stated hard limits.",
    completionRule: "A clear split between negotiable constraints and fixed constraints.",
  },
  {
    key: "dailyBudget",
    scope: "trip",
    description: "Per-person daily amount, currency, what it covers, firm or flexible.",
    completionRule: "An explicit amount with currency and scope, or an explicit no-limit answer.",
  },
  {
    key: "totalBudget",
    scope: "trip",
    description: "Per-person total trip amount, currency, what it covers, firm or flexible.",
    completionRule: "An explicit amount with currency and scope, or an explicit no-limit answer.",
  },
  {
    key: "preferences",
    scope: "general",
    description: "Interests, dislikes, and priorities (seed categories: food, nature, museums, restaurants, bars).",
    completionRule: "Explicit interests/dislikes, or an explicit no-preference answer.",
  },
]

/**
 * Fields the onboarding chat asks for right now. Everything else in REQUIRED_FIELDS
 * stays defined and versioned, but does not block readiness until it is added here.
 * Current product decision (2026-10-31): keep onboarding to restaurant preferences only.
 */
export const ONBOARDING_REQUIRED_KEYS: readonly FieldKey[] = ["preferences"]

// ---- Field state with provenance -------------------------------------------

export const fieldStateSchema = z.object({
  status: fieldStatusSchema,
  value: z.unknown().optional(),
  /** IDs of the onboarding messages whose content supports this value. */
  supportingAnswerIds: z.array(z.string()),
  /** Why clarification is needed, or any note the extractor left. */
  note: z.string().optional(),
  updatedAt: isoDateTime,
})
export type FieldState = z.infer<typeof fieldStateSchema>

export const tripRequirementsSchema = z.object({
  schemaVersion: z.number().int().positive(),
  /** Monotonic per (user, trip). Bumps on every applied patch. */
  profileVersion: z.number().int().nonnegative(),
  fields: z.partialRecord(fieldKeySchema, fieldStateSchema),
})
export type TripRequirements = z.infer<typeof tripRequirementsSchema>

export const generalProfileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  version: z.number().int().nonnegative(),
  preferences: fieldStateSchema.optional(),
})
export type GeneralProfile = z.infer<typeof generalProfileSchema>

export function emptyRequirements(now: string): TripRequirements {
  return { schemaVersion: PROFILE_SCHEMA_VERSION, profileVersion: 0, fields: {} }
}

/** Validates a value against its field schema. Returns the parsed value or an error message. */
export function validateFieldValue(
  key: FieldKey,
  value: unknown,
): { ok: true; value: FieldValue } | { ok: false; error: string } {
  const result = fieldValueSchemas[key].safeParse(value)
  if (result.success) return { ok: true, value: result.data as FieldValue }
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
}

/**
 * Schema-driven completeness. A field counts as complete only when its status is
 * `answered` AND its stored value validates against the current field schema.
 * Fields absent from the record (e.g. newly added required fields) are `missing`.
 */
export function computeMissingFields(requirements: TripRequirements, keys: readonly FieldKey[] = ONBOARDING_REQUIRED_KEYS): FieldKey[] {
  const missing: FieldKey[] = []
  for (const key of keys) {
    const state = requirements.fields[key]
    if (!state || state.status !== "answered") {
      missing.push(key)
      continue
    }
    if (!validateFieldValue(key, state.value).ok) missing.push(key)
  }
  return missing
}

export function isProfileComplete(requirements: TripRequirements, keys: readonly FieldKey[] = ONBOARDING_REQUIRED_KEYS): boolean {
  return computeMissingFields(requirements, keys).length === 0
}

/** The REQUIRED_FIELDS specs that are active for onboarding, in spec order. */
export function activeRequiredFields(keys: readonly FieldKey[] = ONBOARDING_REQUIRED_KEYS): RequiredFieldSpec[] {
  return REQUIRED_FIELDS.filter((f) => keys.includes(f.key))
}
