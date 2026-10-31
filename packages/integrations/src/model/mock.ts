import type { ModelProvider, StructuredRequest, StructuredResult } from "./types.js"
import {
  type Budget,
  type FieldKey,
  type PersonalAgentTurnOutput,
  type QuestionAgentContext,
  type QuestionAgentOutput,
  type ProfilePatch,
  type Proposal,
  type TripRequirements,
  COST_LABEL,
} from "@mycorr/contracts"

/**
 * MOCK MODEL - deterministic, rule-based. Clearly not an AI model.
 * It exists so the full onboarding -> planning -> transcript flow and all failure
 * handling can run without credentials. A passing mock demo says nothing about the
 * real provider integration.
 *
 * It dispatches on `schemaName` and parses the JSON context the agent runner sends
 * as the user message.
 */
export class MockModelProvider implements ModelProvider {
  readonly name = "mock"
  readonly modelId = "mock-rules-v1"

  async complete<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const usage = { inputTokens: Math.ceil(request.user.length / 4), outputTokens: 200 }
    let context: unknown
    try {
      context = JSON.parse(request.user)
    } catch {
      return { ok: false, error: "mock model expects a JSON context as the user message", retryable: false, usage }
    }
    let candidate: unknown
    switch (request.schemaName) {
      case "question_agent_output":
        candidate = mockQuestionTurn(context as QuestionAgentContext)
        break
      case "personal_agent_turn":
        candidate = mockPersonalTurn(context as PersonalTurnContext)
        break
      default:
        return { ok: false, error: `mock model has no rule set for ${request.schemaName}`, retryable: false, usage }
    }
    const parsed = request.schema.safeParse(candidate)
    if (!parsed.success) {
      return { ok: false, error: `mock output failed validation: ${parsed.error.message}`, retryable: false, usage, raw: JSON.stringify(candidate) }
    }
    return { ok: true, value: parsed.data, usage, raw: JSON.stringify(candidate) }
  }
}

// ---- question agent rules ----------------------------------------------------------------

const CATEGORY_WORDS: Record<string, RegExp> = {
  food: /\b(food|foodie|eat|eating|cuisine|street food|tapas|pastry|pastries)\b/i,
  restaurants: /\b(restaurants?|dinner|dining|fine dining|brunch)\b/i,
  nature: /\b(nature|hik(e|ing)|park|parks|beach|beaches|outdoors?|trail|trails|mountain|mountains|garden|gardens)\b/i,
  museums: /\b(museums?|art|gallery|galleries|history|historical|exhibits?|architecture)\b/i,
  bars: /\b(bars?|nightlife|drinks|cocktails?|pubs?|clubs?|wine bar)\b/i,
}

const QUESTIONS: Record<FieldKey, string> = {
  availability: "When are you available during the trip dates? You can say the whole range works, or name specific days and times (with your timezone).",
  flexibility: "What are you flexible on (schedule, spending, activities) and what is fixed for you?",
  dailyBudget: "What's your daily budget per person? Please include the currency, whether it's a firm cap or flexible, and what it covers (everything, or excluding lodging?).",
  totalBudget: "Do you have a total budget for the whole trip, or no total limit? Include the currency and what it covers.",
  preferences: "What are you into on this trip (food, nature, museums, restaurants, bars, anything else), and anything you'd rather avoid?",
}

export function mockQuestionTurn(ctx: QuestionAgentContext): QuestionAgentOutput {
  const unprocessed = ctx.messages.filter((m) => ctx.unprocessedMessageIds.includes(m.id)).map((m) => m.text)
  const text = unprocessed.join("\n")
  const lower = text.toLowerCase()
  const fields: ProfilePatch["fields"] = {}
  const missing = new Set(ctx.missingFields)

  // availability
  if (missing.has("availability")) {
    if (/\b(whole|entire|all|any ?time|every day|full)\b.*\b(weekend|range|trip|time|days|dates)\b|\bfree (the )?(whole|entire)\b|\bworks for me\b|\bfully available\b/i.test(text)) {
      fields.availability = { status: "answered", value: { kind: "whole_range" } }
    } else {
      const windows = weekdayWindows(text, ctx.trip.dateRange)
      if (windows.length) fields.availability = { status: "answered", value: { kind: "windows", timezone: ctx.trip.timezone, windows } }
      else if (/\b(available|free|availability)\b/i.test(text)) fields.availability = { status: "needs_clarification", note: "Which specific days/times inside the trip dates?" }
    }
  }

  // budgets
  const budgets = extractBudgets(text)
  for (const b of budgets) {
    if (b.target === "ambiguous") {
      if (missing.has("dailyBudget")) fields.dailyBudget = { status: "needs_clarification", note: "Is that a daily budget or a total budget?" }
      else if (missing.has("totalBudget")) fields.totalBudget = { status: "needs_clarification", note: "Is that a daily budget or a total budget?" }
      continue
    }
    const key: FieldKey = b.target === "daily" ? "dailyBudget" : "totalBudget"
    if (b.value.kind === "amount" && (!b.value.currency || !b.value.scope || !b.value.firmness)) {
      const need = [!b.value.currency && "currency", !b.value.scope && "what it covers", !b.value.firmness && "firm or flexible"].filter(Boolean).join(", ")
      fields[key] = { status: "needs_clarification", note: `Please specify: ${need}.` }
    } else {
      fields[key] = { status: "answered", value: b.value as Budget }
    }
  }

  // preferences
  if (/\bno preferences?\b|\banything is fine\b|\bno strong preference\b|\bwhatever\b/i.test(text)) {
    fields.preferences = { status: "answered", value: { kind: "no_preference" } }
  } else {
    const interests: { category: string }[] = []
    const dislikes: { category: string }[] = []
    for (const [category, re] of Object.entries(CATEGORY_WORDS)) {
      if (!re.test(text)) continue
      const negative = new RegExp(`(no|not|don'?t like|hate|avoid|skip|without|rather not)[^.,;]{0,25}\\b(${re.source.slice(3, -3)})\\b`, "i")
      if (negative.test(text)) dislikes.push({ category })
      else interests.push({ category })
    }
    if (interests.length || dislikes.length) {
      const priorities = /\bpriorit(y|ies)\b|\bmost important\b|\bmainly\b/i.test(text) ? interests.map((i) => i.category) : []
      fields.preferences = { status: "answered", value: { kind: "stated", interests, dislikes, priorities } }
    }
  }

  // flexibility
  if (/\b(totally|completely|very|fully|pretty|quite) flexible\b|\bflexible on everything\b|\bflexible about everything\b/i.test(lower)) {
    fields.flexibility = { status: "answered", value: { negotiable: ["schedule", "spending", "activities"], fixed: [] } }
  } else {
    const negotiable = matchList(text, /flexible (on|about|with) ([^.;]+)/i)
    const fixed = matchList(text, /\b(fixed|non-?negotiable|must|can'?t change|not flexible on|strict on)\b:? ([^.;]+)/i)
    if (negotiable.length || fixed.length) fields.flexibility = { status: "answered", value: { negotiable, fixed } }
  }

  // next question: first still-missing field after this patch
  const stillMissing = ctx.missingFields.filter((k) => fields[k]?.status !== "answered")
  const clarification = (Object.entries(fields) as [FieldKey, { status: string; note?: string }][]).find(([, p]) => p.status === "needs_clarification")
  if (clarification) return { patch: { fields }, next: { kind: "question", text: clarification[1].note! } }
  if (stillMissing.length) return { patch: { fields }, next: { kind: "question", text: QUESTIONS[stillMissing[0]!] } }
  return { patch: { fields }, next: { kind: "complete", text: "Thanks, I have everything I need. Your agent will take it from here." } }
}

function matchList(text: string, re: RegExp): string[] {
  const m = text.match(re)
  if (!m) return []
  const list = m[m.length - 1]!
  return list.split(/,|\band\b|\/|&/).map((s) => s.trim().replace(/^(the|my)\s+/i, "")).filter((s) => s.length > 0 && s.length < 60)
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

function weekdayWindows(text: string, range: { start: string; end: string }): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = []
  const lower = text.toLowerCase()
  const start = new Date(`${range.start}T00:00:00Z`)
  const end = new Date(`${range.end}T00:00:00Z`)
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const name = WEEKDAYS[d.getUTCDay()]!
    if (!new RegExp(`\\b${name}\\b`, "i").test(lower)) continue
    const iso = d.toISOString().slice(0, 10)
    const afternoon = new RegExp(`${name}[^.;]{0,20}(afternoon|evening)`, "i").test(lower)
    const morning = new RegExp(`${name}[^.;]{0,20}morning`, "i").test(lower)
    out.push({ start: `${iso}T${afternoon ? "13:00" : "09:00"}:00.000Z`, end: `${iso}T${morning ? "12:00" : "22:00"}:00.000Z` })
  }
  return out
}

interface ExtractedBudget {
  target: "daily" | "total" | "ambiguous"
  value: Partial<Extract<Budget, { kind: "amount" }>> | { kind: "no_limit" }
}

function extractBudgets(text: string): ExtractedBudget[] {
  const out: ExtractedBudget[] = []
  const clauses = text.split(/[.;\n]|,\s*(?=(?:and|but|no)\b)|\bbut\b/i).map((c) => c.trim()).filter(Boolean)
  for (const clause of clauses) {
    const lower = clause.toLowerCase()
    const daily = /\b(per day|a day|\/day|daily|each day)\b/.test(lower)
    const total = /\b(total|in total|whole trip|overall|for the (whole )?trip|altogether)\b/.test(lower)
    const target: ExtractedBudget["target"] = daily && !total ? "daily" : total && !daily ? "total" : daily && total ? "daily" : "ambiguous"
    if (/\bno (budget |total |daily |overall |spending )?limit|\bunlimited\b|\bno cap\b|\bno max(imum)?\b/.test(lower)) {
      if (target === "ambiguous" && /\b(either|at all|any)\b/.test(lower)) {
        out.push({ target: "daily", value: { kind: "no_limit" } }, { target: "total", value: { kind: "no_limit" } })
      } else out.push({ target: target === "ambiguous" ? "total" : target, value: { kind: "no_limit" } })
      continue
    }
    const amount = clause.match(/(€|\$|£|eur|usd|gbp)?\s?(\d{2,6})(?:\s?(€|\$|£|eur|euros?|usd|dollars?|bucks|gbp|pounds?))?/i)
    if (!amount || !/\b(budget|spend|spending|afford|max|cap|under|around|about|up to|roughly)\b|€|\$|£/i.test(clause)) continue
    const currencyToken = (amount[1] ?? amount[3] ?? "").toLowerCase()
    const currency = currencyToken
      ? { "€": "EUR", eur: "EUR", euro: "EUR", euros: "EUR", $: "USD", usd: "USD", dollar: "USD", dollars: "USD", bucks: "USD", "£": "GBP", gbp: "GBP", pound: "GBP", pounds: "GBP" }[currencyToken]
      : undefined
    const scope = /\ball[- ]?in\b|\beverything\b|\bincluding (lodging|hotel|accommodation)\b|\bincl\b/.test(lower)
      ? "all"
      : /\bexcluding (lodging|hotel|accommodation)\b|\bnot including (the )?(hotel|lodging)\b|\bwithout (the )?(hotel|lodging)\b|\bhotel separate\b/.test(lower)
        ? "excluding_lodging"
        : /\bfood\b|\bmeals\b/.test(lower) && !/\bactivities\b/.test(lower)
          ? "food"
          : /\bactivities\b/.test(lower)
            ? "activities"
            : undefined
    const firmness = /\bfirm\b|\bstrict\b|\bhard (cap|limit)\b|\bmax(imum)?\b|\bno more than\b/.test(lower)
      ? "firm"
      : /\bflexible\b|\broughly\b|\baround\b|\babout\b|\bish\b|\bgive or take\b/.test(lower)
        ? "flexible"
        : undefined
    out.push({ target, value: { kind: "amount", amountMinor: Number(amount[2]) * 100, currency, scope, firmness } })
  }
  return out
}

// ---- personal agent rules ---------------------------------------------------------------

import type { PersonalTurnContext } from "@mycorr/contracts"
export type { PersonalTurnContext }

function budgetOf(req: TripRequirements, key: "dailyBudget" | "totalBudget"): Budget | undefined {
  const f = req.fields[key]
  return f && f.status === "answered" ? (f.value as Budget) : undefined
}

function days(range: { start: string; end: string }): string[] {
  const out: string[] = []
  for (let d = new Date(`${range.start}T00:00:00Z`); d <= new Date(`${range.end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10))
  return out
}

export function mockPersonalTurn(ctx: PersonalTurnContext): PersonalAgentTurnOutput {
  const prefs = ctx.self.requirements.fields.preferences?.value as { kind: string; interests?: { category: string }[]; dislikes?: { category: string }[] } | undefined
  const interests = prefs?.kind === "stated" && prefs.interests?.length ? prefs.interests.map((i) => i.category) : ["food", "nature"]
  const dislikes = new Set(prefs?.kind === "stated" ? (prefs.dislikes ?? []).map((d) => d.category) : [])
  const daily = budgetOf(ctx.self.requirements, "dailyBudget")
  const currency = daily?.kind === "amount" ? daily.currency : "EUR"
  const dailyCap = daily?.kind === "amount" ? daily.amountMinor : 15000
  const tripDays = days(ctx.trip.dateRange)

  if (ctx.phase === "propose") {
    // Learn from earlier rounds: drop categories other agents flagged as something they asked to avoid.
    const flagged = new Set(ctx.evaluations.flatMap((e) => e.hardConstraintViolations.map((v) => v.match(/is a (\w+) activity/)?.[1]).filter((c): c is string => !!c)))
    const usable = interests.filter((c) => !flagged.has(c))
    if (usable.length) interests.splice(0, interests.length, ...usable)
    else if (flagged.size) interests.splice(0, interests.length, ...["food", "nature", "restaurants", "museums", "bars"].filter((c) => !flagged.has(c) && !dislikes.has(c)).slice(0, 2))
    const capsSeen = ctx.evaluations.flatMap((e) => e.hardConstraintViolations.map((v) => v.match(/exceeds my daily budget (\d+)/)?.[1]).filter((c): c is string => !!c)).map((c) => Number(c) * 100)
    const effectiveCap = Math.min(dailyCap, ...capsSeen)
    const perItem = Math.floor(effectiveCap / 2)
    const items = tripDays.flatMap((day, i) => {
      const a = interests[i % interests.length]!
      const b = interests[(i + 1) % interests.length]!
      return [
        { day, startTime: "10:00", endTime: "13:00", title: `${capitalize(a)} morning in ${ctx.trip.city}`, category: a, estimatedCostMinor: perItem, currency, costLabel: COST_LABEL },
        { day, startTime: "16:00", endTime: "20:00", title: `${capitalize(b)} in the evening`, category: b, estimatedCostMinor: perItem, currency, costLabel: COST_LABEL },
      ]
    })
    return {
      message: `[${ctx.self.agentName}] Proposal for ${ctx.trip.city}: ${interests.join(" + ")} across ${tripDays.length} day(s), about ${(effectiveCap / 100).toFixed(0)} ${currency}/day (unverified estimates).`,
      proposal: { title: `${capitalize(interests[0]!)}-first plan`, items, notes: "Mock proposal derived from stated interests and daily budget." },
    }
  }

  if (ctx.phase === "evaluate") {
    const evaluations = ctx.proposals
      .filter((p) => p.byUserId !== ctx.self.userId && p.round === ctx.round)
      .map((p) => {
        const violations: string[] = []
        const concerns: string[] = []
        const uncertain: string[] = []
        for (const day of tripDays) {
          const spend = p.items.filter((i) => i.day === day).reduce((s, i) => s + (i.estimatedCostMinor ?? 0), 0)
          if (daily?.kind === "amount" && spend > daily.amountMinor) violations.push(`day ${day} estimated ${spend / 100} ${currency} exceeds my daily budget ${daily.amountMinor / 100} ${daily.currency}`)
          if (p.items.some((i) => i.day === day && i.estimatedCostMinor === undefined)) uncertain.push(`day ${day} has items without a cost estimate`)
        }
        for (const item of p.items) if (dislikes.has(item.category)) violations.push(`${item.title} is a ${item.category} activity, which I asked to avoid`)
        const verdict = violations.length ? "reject" : concerns.length ? "accept_with_changes" : "accept"
        return { proposalId: p.proposalId, verdict: verdict as "accept" | "accept_with_changes" | "reject", hardConstraintViolations: violations, concerns, uncertain }
      })
    const summary = evaluations.map((e) => `${e.proposalId.slice(0, 12)}: ${e.verdict}${e.hardConstraintViolations.length ? ` (${e.hardConstraintViolations[0]})` : ""}`).join("; ")
    return { message: `[${ctx.self.agentName}] Evaluations: ${summary || "nothing to evaluate"}.`, evaluations }
  }

  if (ctx.phase === "assemble") {
    const current = ctx.proposals.filter((p) => p.round === ctx.round)
    const rejected = new Set(ctx.evaluations.filter((e) => e.verdict === "reject" && e.round === ctx.round).map((e) => e.proposalId))
    const accepted = current.filter((p) => !rejected.has(p.proposalId))
    const pool = accepted.length ? accepted : current
    const itineraryDays = tripDays.map((date) => {
      // One slot per accepted proposal so every participant's interests appear; alternate morning/evening slots.
      const items = pool
        .map((p, k) => p.items.filter((i) => i.day === date)[k % 2] ?? p.items.find((i) => i.day === date))
        .filter((i): i is NonNullable<typeof i> => !!i)
        .slice(0, 2)
      return { date, items }
    })
    const conflicts = current
      .filter((p) => rejected.has(p.proposalId))
      .map((p) => ({
        topic: `Proposal "${p.title}" rejected`,
        participantIds: Array.from(new Set([p.byUserId, ...ctx.evaluations.filter((e) => e.proposalId === p.proposalId && e.verdict === "reject").map((e) => e.byUserId)])),
        description: ctx.evaluations.filter((e) => e.proposalId === p.proposalId && e.verdict === "reject").flatMap((e) => e.hardConstraintViolations).join("; ") || "rejected without stated violation",
      }))
    return {
      message: `[${ctx.self.agentName}] Draft itinerary assembled from ${pool.length} proposal(s); ${conflicts.length} unresolved conflict(s).`,
      itinerary: { days: itineraryDays, notes: "Draft assembled by the mock model. Costs are unverified estimates.", sourceProposalIds: pool.map((p) => p.proposalId) },
      conflicts,
    }
  }

  // respond: a directed message asked us something
  return { message: `[${ctx.self.agentName}] Noted: "${ctx.incoming?.text.slice(0, 80) ?? ""}". My constraints are unchanged.` }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
