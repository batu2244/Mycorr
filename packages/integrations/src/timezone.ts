import { z } from "zod"
import type { ModelProvider } from "./model/types.js"

/**
 * Resolves the IANA timezone for a trip city so the creator never has to type it.
 * Order: an explicit valid override, a local table of common cities, then one
 * structured model call. Every candidate is checked against the runtime's own
 * timezone list, so a bad guess can never be stored. If nothing resolves, the
 * caller gets "UTC" and `derived: false` so it can show that it is a fallback.
 */

export interface TimezoneResolution {
  timezone: string
  /** "override" | "table" | "model" | "fallback" */
  source: "override" | "table" | "model" | "fallback"
  derived: boolean
}

const CITY_TIMEZONES: Record<string, string> = {
  // Europe
  lisbon: "Europe/Lisbon", porto: "Europe/Lisbon", madrid: "Europe/Madrid", barcelona: "Europe/Madrid",
  seville: "Europe/Madrid", paris: "Europe/Paris", lyon: "Europe/Paris", nice: "Europe/Paris",
  london: "Europe/London", edinburgh: "Europe/London", dublin: "Europe/Dublin", amsterdam: "Europe/Amsterdam",
  brussels: "Europe/Brussels", berlin: "Europe/Berlin", munich: "Europe/Berlin", hamburg: "Europe/Berlin",
  vienna: "Europe/Vienna", zurich: "Europe/Zurich", geneva: "Europe/Zurich", milan: "Europe/Rome",
  rome: "Europe/Rome", florence: "Europe/Rome", venice: "Europe/Rome", naples: "Europe/Rome",
  prague: "Europe/Prague", budapest: "Europe/Budapest", warsaw: "Europe/Warsaw", krakow: "Europe/Warsaw",
  copenhagen: "Europe/Copenhagen", stockholm: "Europe/Stockholm", oslo: "Europe/Oslo", helsinki: "Europe/Helsinki",
  athens: "Europe/Athens", istanbul: "Europe/Istanbul", reykjavik: "Atlantic/Reykjavik",
  // Americas
  "new york": "America/New_York", nyc: "America/New_York", boston: "America/New_York", miami: "America/New_York",
  washington: "America/New_York", philadelphia: "America/New_York", atlanta: "America/New_York",
  chicago: "America/Chicago", austin: "America/Chicago", houston: "America/Chicago", dallas: "America/Chicago",
  "new orleans": "America/Chicago", nashville: "America/Chicago", denver: "America/Denver",
  "salt lake city": "America/Denver", phoenix: "America/Phoenix", "los angeles": "America/Los_Angeles",
  la: "America/Los_Angeles", "san francisco": "America/Los_Angeles", "san diego": "America/Los_Angeles",
  seattle: "America/Los_Angeles", portland: "America/Los_Angeles", "las vegas": "America/Los_Angeles",
  vancouver: "America/Vancouver", toronto: "America/Toronto", montreal: "America/Toronto",
  "mexico city": "America/Mexico_City", cancun: "America/Cancun", havana: "America/Havana",
  bogota: "America/Bogota", lima: "America/Lima", santiago: "America/Santiago",
  "buenos aires": "America/Argentina/Buenos_Aires", "sao paulo": "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo",
  honolulu: "Pacific/Honolulu",
  // Africa and Middle East
  cairo: "Africa/Cairo", marrakech: "Africa/Casablanca", casablanca: "Africa/Casablanca",
  "cape town": "Africa/Johannesburg", johannesburg: "Africa/Johannesburg", nairobi: "Africa/Nairobi",
  dubai: "Asia/Dubai", "abu dhabi": "Asia/Dubai", doha: "Asia/Qatar", "tel aviv": "Asia/Jerusalem", jerusalem: "Asia/Jerusalem",
  // Asia and Pacific
  tokyo: "Asia/Tokyo", kyoto: "Asia/Tokyo", osaka: "Asia/Tokyo", seoul: "Asia/Seoul", beijing: "Asia/Shanghai",
  shanghai: "Asia/Shanghai", "hong kong": "Asia/Hong_Kong", taipei: "Asia/Taipei", singapore: "Asia/Singapore",
  bangkok: "Asia/Bangkok", "chiang mai": "Asia/Bangkok", hanoi: "Asia/Ho_Chi_Minh", "ho chi minh city": "Asia/Ho_Chi_Minh",
  "kuala lumpur": "Asia/Kuala_Lumpur", bali: "Asia/Makassar", jakarta: "Asia/Jakarta", manila: "Asia/Manila",
  mumbai: "Asia/Kolkata", delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", bangalore: "Asia/Kolkata", goa: "Asia/Kolkata",
  kathmandu: "Asia/Kathmandu", sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", brisbane: "Australia/Brisbane",
  perth: "Australia/Perth", auckland: "Pacific/Auckland", queenstown: "Pacific/Auckland",
}

const VALID_ZONES = new Set<string>(Intl.supportedValuesOf("timeZone"))

export function isValidTimezone(zone: string | undefined): zone is string {
  return !!zone && VALID_ZONES.has(zone)
}

function normalizeCity(city: string): string {
  return city
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Table lookup only. Tries the full string, then the part before a comma ("Lisbon, Portugal"). */
export function timezoneFromTable(city: string): string | undefined {
  const full = normalizeCity(city)
  if (CITY_TIMEZONES[full]) return CITY_TIMEZONES[full]
  const head = normalizeCity(city.split(",")[0] ?? "")
  return CITY_TIMEZONES[head]
}

const cityTimezoneSchema = z.object({ timezone: z.string().min(1) })

export async function resolveTimezone(city: string, override?: string, model?: ModelProvider): Promise<TimezoneResolution> {
  if (isValidTimezone(override)) return { timezone: override, source: "override", derived: false }

  const fromTable = timezoneFromTable(city)
  if (isValidTimezone(fromTable)) return { timezone: fromTable, source: "table", derived: true }

  if (model) {
    const result = await model.complete({
      system: "You map a city name to its IANA timezone identifier. Answer with the identifier only, for example Europe/Lisbon.",
      user: JSON.stringify({ city }),
      schema: cityTimezoneSchema,
      schemaName: "city_timezone",
      maxTokens: 200,
    })
    if (result.ok && isValidTimezone(result.value.timezone)) return { timezone: result.value.timezone, source: "model", derived: true }
  }

  return { timezone: "UTC", source: "fallback", derived: false }
}
