// K+ Packing Intelligence V1 — request/plan contract (pure).
//
// WHY THIS LIVES IN stylechat-generate. Packing is not a second Elise and not a
// second AI provider: it is a structured fashion task the ONE Elise backend
// already has every primitive for -- JWT identity, the account-lifecycle gate,
// the shared Elise burst/daily quota RPCs, the K+ entitlement resolution
// (has_active_k_plus), the authoritative Closet (user_closet_items), and the
// server-derived Signature Style profile. A new Edge Function would have had to
// re-implement all seven.
//
// NOTHING HERE TOUCHES THE NETWORK OR Deno. Every module in the Packing set is
// pure so it is unit-testable without a runtime, exactly like reasoningContract.ts
// and actions.ts already are.
//
// TRUST MODEL. `destination`, `note` and every constraint note are USER TEXT.
// They are data forever: bounded here, escaped at the prompt boundary
// (packingPrompt.ts), and never interpreted as instructions. A destination
// reading "Ignore all previous instructions" is a destination.

export const PACKING_CONTRACT_VERSION = 'packing_plan_v1';

/** The exact immutable top-level discriminator that selects the Packing path. */
export const PACKING_REQUEST_SCHEMA_VERSION = 'packing-plan-v1';

export const PACKING_LIMITS = {
  /**
   * Authoritative Closet rows fetched before deterministic narrowing.
   *
   * THIS IS A CENSUS BOUND, NOT A PROMPT BOUND. The prompt stays bounded by
   * shortlistTarget (14) however large this is -- a 200-item Closet and a
   * 25-item Closet produce the same ~1,228-token prompt. What this decides is
   * how much of the Closet the server is allowed to KNOW ABOUT, and that is
   * what closetRoleCensus (gap derivation, scarcity signals) and role coverage
   * are computed from.
   *
   * At 40 the retrieval window was pure updated_at DESC, so a traveller with
   * 150 recently-touched tops was told "Your Closet has no footwear yet" while
   * owning two pairs of shoes, and their shortlist held 14 tops and no shoes.
   * Coverage-before-truncation cannot recover a garment retrieval never fetched.
   * Pre-model cost at 200 rows is 0.37ms, so the honest bound is also the cheap
   * one.
   *
   * Beyond this bound the census is INCOMPLETE and is marked as such; an
   * incomplete census may never assert an absence. See packingRetrieval.ts.
   */
  maxClosetCandidates: 200,
  /** Bounded shortlist handed to the model. */
  shortlistTarget: 14,
  shortlistHardMax: 18,
  /** Below this many usable owned candidates a personalized plan is not honest. */
  minCandidatesForPersonalPlan: 5,
  maxTripNights: 30,
  maxActivities: 6,
  maxDestinationChars: 80,
  maxNoteChars: 300,
  maxConstraintNotes: 8,
  maxExcludedItems: 40,
  maxOutfits: 8,
  maxPackedItems: 24,
  maxItemsPerOutfit: 6,
  /** Build 35. Occasions a single day may carry (daytime + dinner + night out). */
  maxActivitiesPerDay: 3,
  /**
   * Build 35. Days planned look-by-look. Longer trips repeat the first week's
   * looks on later days, and the plan SAYS so -- see packingTripPlanner.ts.
   */
  maxPlannedDays: 7,
  /** Build 35. Hard bound on day/occasion slots the model is asked to fill. */
  maxSlots: 21,
  maxRefinementChars: 300,
} as const;

/**
 * Build 35 -- trip-level planner generation. Carried on the plan and its state
 * so a client can tell a day-by-day plan from a V1 occasion list without
 * guessing from which fields happen to be present.
 */
export const PACKING_PLANNER_VERSION = 2;

/**
 * Conditions the TRAVELLER stated ("it's going to rain"). Deliberately not a
 * weather source: nothing here geocodes, forecasts or reads the device's own
 * location. A condition is a trip requirement the traveller told us about.
 */
export const PACKING_CONDITIONS = ['rain', 'snow', 'cold', 'hot'] as const;
export type PackingCondition = (typeof PACKING_CONDITIONS)[number];

export interface PackingDaySchedule {
  /** 0-based offset from startDate. */
  dayIndex: number;
  date: string;
  activities: PackingActivity[];
}

export const PACKING_TRIP_TYPES = [
  'leisure',
  'business',
  'beach',
  'city',
  'outdoors',
  'event',
  'other',
] as const;
export type PackingTripType = (typeof PACKING_TRIP_TYPES)[number];

/**
 * Trip REQUIREMENT vocabulary. Deliberately not a garment taxonomy -- the
 * garment taxonomy is the Closet's own (category / clothing_type / subtype,
 * reduced to a layering role by eliseFashionFeatures.inferLayeringRole) and
 * this project keeps exactly one of those. These are the occasions a trip can
 * contain; packingCandidates.ts maps them onto the EXISTING layering roles.
 */
export const PACKING_ACTIVITIES = [
  'travel_day',
  'casual_day',
  'dinner',
  'work',
  'beach',
  'outdoors',
  'workout',
  'formal_event',
  'nightlife',
] as const;
export type PackingActivity = (typeof PACKING_ACTIVITIES)[number];

export const PACKING_ACTIVITY_LABELS: Record<PackingActivity, string> = {
  travel_day: 'Travel',
  casual_day: 'Daytime',
  dinner: 'Dinner',
  work: 'Work',
  beach: 'Beach',
  outdoors: 'Outdoors',
  workout: 'Workout',
  formal_event: 'Formal event',
  nightlife: 'Evening out',
};

export type PackingWeatherProvenance = 'FORECAST' | 'SEASONAL' | 'UNAVAILABLE';

export interface PackingTripInput {
  destination: string;
  startDate: string;
  endDate: string;
  nights: number;
  tripType: PackingTripType;
  activities: PackingActivity[];
  note: string | null;
  /**
   * Build 35. One entry per trip day, each with its own occasions. Optional on
   * the type so a V1 caller that never sent a schedule still type-checks; the
   * planner derives one (and says it did) when this is absent.
   */
  schedule?: PackingDaySchedule[];
  scheduleSource?: 'explicit' | 'derived';
  /** Build 35. Conditions the traveller stated. Never a forecast. */
  conditions?: PackingCondition[];
}

export interface PackingConstraints {
  /** Authoritative Closet ids the user has excluded for THIS trip only. */
  excludeItemIds: string[];
  packLight: boolean;
  /** Free-text refinement constraints ("no heels"). Untrusted data. */
  notes: string[];
  /** Build 35. "Only from my Closet" -- no external suggestion of any kind. */
  ownedOnly?: boolean;
}

/**
 * Build 35. A refinement of the plan currently on screen.
 *
 * `resolvedItemId` is the traveller's answer to a clarification ("which
 * blazer?"). It is a REQUEST, honoured only when the id is part of the prior
 * plan AND re-resolves against this actor's freshly retrieved Closet.
 */
export interface PackingRefinementRequest {
  message: string;
  resolvedItemId: string | null;
  /** The traveller's answer to "which Friday?" -- an ISO date inside the trip. */
  resolvedDate?: string | null;
}

export interface ParsedPackingRequest {
  ok: true;
  sessionId: string;
  trip: PackingTripInput;
  constraints: PackingConstraints;
  /**
   * Build 35. 2 selects the day-by-day trip planner. Absent or anything else is
   * the V1 occasion list, byte-for-byte -- a client that never asked for a
   * planned trip never receives one.
   */
  plannerVersion?: 1 | 2;
  refinement?: PackingRefinementRequest | null;
  /**
   * Build 35. The structured plan state the client holds, UNPARSED. It
   * round-trips through the device and is untrusted: packingPlanState.ts
   * validates it and re-verifies every id against this actor's own Closet
   * before any of it can influence a plan.
   */
  priorState?: unknown;
}

export interface RejectedPackingRequest {
  ok: false;
  errorCode:
    | 'PACKING_INVALID_TRIP'
    | 'PACKING_INVALID_DATES'
    | 'PACKING_TRIP_TOO_LONG'
    | 'PACKING_INVALID_SESSION';
  message: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collapse control characters and clamp. Escaping for the prompt is a SEPARATE
 * step (packingPrompt.ts) -- this only bounds what we are willing to store and
 * echo back, so a caller that forgets to escape still cannot smuggle a control
 * sequence through.
 */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

/** Parses a calendar date with no timezone maths: dates are trip facts, not instants. */
function parseCalendarDate(value: unknown): { iso: string; ms: number } | null {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value.trim())) return null;
  const iso = value.trim();
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rolls an out-of-range day over on some engines, so re-render and
  // compare: an impossible calendar date must be rejected, never silently
  // become a different trip.
  if (new Date(ms).toISOString().slice(0, 10) !== iso) return null;
  return { iso, ms };
}

export function classifyPackingRequest(body: unknown): 'packing' | 'not_packing' {
  if (!isRecord(body)) return 'not_packing';
  return body.schemaVersion === PACKING_REQUEST_SCHEMA_VERSION ? 'packing' : 'not_packing';
}

export function parsePackingRequest(body: unknown): ParsedPackingRequest | RejectedPackingRequest {
  if (!isRecord(body)) {
    return { ok: false, errorCode: 'PACKING_INVALID_TRIP', message: 'A trip is required.' };
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return {
      ok: false,
      errorCode: 'PACKING_INVALID_SESSION',
      message: 'sessionId must be a valid UUID.',
    };
  }

  const trip = isRecord(body.trip) ? body.trip : null;
  if (!trip) {
    return { ok: false, errorCode: 'PACKING_INVALID_TRIP', message: 'A trip is required.' };
  }

  const destination = boundedText(trip.destination, PACKING_LIMITS.maxDestinationChars);
  if (!destination) {
    return { ok: false, errorCode: 'PACKING_INVALID_TRIP', message: 'A destination is required.' };
  }

  const start = parseCalendarDate(trip.startDate);
  const end = parseCalendarDate(trip.endDate);
  if (!start || !end) {
    return {
      ok: false,
      errorCode: 'PACKING_INVALID_DATES',
      message: 'Trip dates must be calendar dates.',
    };
  }
  if (end.ms < start.ms) {
    return {
      ok: false,
      errorCode: 'PACKING_INVALID_DATES',
      message: 'The return date is before the departure date.',
    };
  }
  const nights = Math.round((end.ms - start.ms) / MS_PER_DAY);
  if (nights > PACKING_LIMITS.maxTripNights) {
    return {
      ok: false,
      errorCode: 'PACKING_TRIP_TOO_LONG',
      message: `Trips longer than ${PACKING_LIMITS.maxTripNights} nights are not supported yet.`,
    };
  }

  const tripType: PackingTripType =
    typeof trip.tripType === 'string' &&
    (PACKING_TRIP_TYPES as readonly string[]).includes(trip.tripType)
      ? (trip.tripType as PackingTripType)
      : 'other';

  // Unknown activity tokens are DROPPED, never mapped to a nearest neighbour: a
  // silently substituted requirement would produce a plan for a trip the user
  // did not describe.
  const rawActivities = Array.isArray(trip.activities) ? trip.activities : [];
  const activities: PackingActivity[] = [];
  for (const entry of rawActivities) {
    if (typeof entry !== 'string') continue;
    if (!(PACKING_ACTIVITIES as readonly string[]).includes(entry)) continue;
    if (activities.includes(entry as PackingActivity)) continue;
    activities.push(entry as PackingActivity);
    if (activities.length >= PACKING_LIMITS.maxActivities) break;
  }

  const rawConstraints = isRecord(body.constraints) ? body.constraints : {};
  const excludeItemIds: string[] = [];
  const rawExcluded = Array.isArray(rawConstraints.excludeItemIds)
    ? rawConstraints.excludeItemIds
    : [];
  for (const entry of rawExcluded) {
    if (typeof entry !== 'string' || !UUID_RE.test(entry)) continue;
    const id = entry.toLowerCase();
    if (excludeItemIds.includes(id)) continue;
    excludeItemIds.push(id);
    if (excludeItemIds.length >= PACKING_LIMITS.maxExcludedItems) break;
  }

  const constraintNotes: string[] = [];
  const rawNotes = Array.isArray(rawConstraints.notes) ? rawConstraints.notes : [];
  for (const entry of rawNotes) {
    const note = boundedText(entry, PACKING_LIMITS.maxNoteChars);
    if (!note) continue;
    constraintNotes.push(note);
    if (constraintNotes.length >= PACKING_LIMITS.maxConstraintNotes) break;
  }

  const note = boundedText(trip.note, PACKING_LIMITS.maxNoteChars);
  const explicitSchedule = parseExplicitSchedule(trip.schedule, start.ms, nights);
  const schedule = explicitSchedule ?? derivePackingSchedule({
    startDate: start.iso,
    nights,
    activities,
    tripType,
  });

  const conditions: PackingCondition[] = [];
  const rawConditions = Array.isArray(trip.conditions) ? trip.conditions : [];
  for (const entry of rawConditions) {
    if (typeof entry !== 'string') continue;
    if (!(PACKING_CONDITIONS as readonly string[]).includes(entry)) continue;
    if (!conditions.includes(entry as PackingCondition)) conditions.push(entry as PackingCondition);
  }
  for (const stated of [note, ...constraintNotes]) {
    for (const condition of readStatedConditions(stated)) {
      if (!conditions.includes(condition)) conditions.push(condition);
    }
  }

  const rawRefinement = isRecord(body.refinement) ? body.refinement : null;
  const refinementMessage = rawRefinement
    ? boundedText(rawRefinement.message, PACKING_LIMITS.maxRefinementChars)
    : null;
  const resolvedItemId =
    rawRefinement && typeof rawRefinement.resolvedItemId === 'string' &&
      UUID_RE.test(rawRefinement.resolvedItemId)
      ? rawRefinement.resolvedItemId.toLowerCase()
      : null;
  const resolvedDateParsed = rawRefinement ? parseCalendarDate(rawRefinement.resolvedDate) : null;
  const resolvedDate =
    resolvedDateParsed && resolvedDateParsed.ms >= start.ms && resolvedDateParsed.ms <= end.ms
      ? resolvedDateParsed.iso
      : null;

  return {
    ok: true,
    sessionId,
    trip: {
      destination,
      startDate: start.iso,
      endDate: end.iso,
      nights,
      tripType,
      activities,
      note,
      schedule,
      scheduleSource: explicitSchedule ? 'explicit' : 'derived',
      conditions,
    },
    constraints: {
      excludeItemIds,
      packLight: rawConstraints.packLight === true,
      notes: constraintNotes,
      ownedOnly: rawConstraints.ownedOnly === true,
    },
    plannerVersion: body.plannerVersion === PACKING_PLANNER_VERSION ? 2 : 1,
    refinement: refinementMessage ? { message: refinementMessage, resolvedItemId, resolvedDate } : null,
    // Passed through UNPARSED on purpose: only packingPlanState.ts, holding the
    // actor's freshly retrieved Closet, is allowed to decide what survives.
    priorState: isRecord(body.priorState) ? body.priorState : null,
  };
}

function isoDayOffset(startMs: number, dayIndex: number): string {
  return new Date(startMs + dayIndex * MS_PER_DAY).toISOString().slice(0, 10);
}

function dedupeActivities(values: unknown): PackingActivity[] {
  const out: PackingActivity[] = [];
  if (!Array.isArray(values)) return out;
  for (const entry of values) {
    if (typeof entry !== 'string') continue;
    if (!(PACKING_ACTIVITIES as readonly string[]).includes(entry)) continue;
    if (out.includes(entry as PackingActivity)) continue;
    out.push(entry as PackingActivity);
    if (out.length >= PACKING_LIMITS.maxActivitiesPerDay) break;
  }
  return out;
}

/**
 * A schedule the traveller built day by day. Entries outside the trip's own
 * dates are DROPPED -- a Saturday dinner on a trip that ends Friday is not a
 * requirement of this trip. A day left without any occasion keeps an empty
 * list here and is given a daytime look by the planner, which says so.
 */
function parseExplicitSchedule(
  value: unknown,
  startMs: number,
  nights: number,
): PackingDaySchedule[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const days: PackingDaySchedule[] = [];
  for (let dayIndex = 0; dayIndex <= nights; dayIndex += 1) {
    days.push({ dayIndex, date: isoDayOffset(startMs, dayIndex), activities: [] });
  }
  let accepted = 0;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const parsed = parseCalendarDate(entry.date);
    if (!parsed) continue;
    const dayIndex = Math.round((parsed.ms - startMs) / MS_PER_DAY);
    if (dayIndex < 0 || dayIndex > nights) continue;
    days[dayIndex].activities = dedupeActivities(entry.activities);
    accepted += 1;
  }
  return accepted > 0 ? days : null;
}

/**
 * The schedule when the traveller named occasions for the whole trip but not
 * per day. Travel sits on the first and last day only; every other chosen
 * occasion is assumed to recur daily. packingHandler surfaces this assumption
 * in the plan, so a derived schedule is never presented as the traveller's own.
 */
export function derivePackingSchedule(input: {
  startDate: string;
  nights: number;
  activities: PackingActivity[];
  tripType: PackingTripType;
}): PackingDaySchedule[] {
  const startMs = Date.parse(`${input.startDate}T00:00:00Z`);
  const daily = input.activities.filter((activity) => activity !== 'travel_day');
  const travels = input.activities.includes('travel_day');
  const fallback: PackingActivity = input.tripType === 'business' ? 'work' : 'casual_day';
  const days: PackingDaySchedule[] = [];
  for (let dayIndex = 0; dayIndex <= input.nights; dayIndex += 1) {
    const edge = dayIndex === 0 || dayIndex === input.nights;
    const activities: PackingActivity[] = [];
    if (travels && edge) activities.push('travel_day');
    for (const activity of daily) {
      if (activities.length >= PACKING_LIMITS.maxActivitiesPerDay) break;
      activities.push(activity);
    }
    if (activities.length === 0) activities.push(fallback);
    days.push({ dayIndex, date: isoDayOffset(startMs, dayIndex), activities });
  }
  return days;
}

const CONDITION_PATTERNS: Array<[PackingCondition, RegExp, RegExp]> = [
  ['rain', /\b(?:rain|rainy|raining|showers|downpours?|wet weather)\b/i, /\b(?:no|not|without)\s+(?:\w+\s+){0,2}(?:rain|showers)\b/i],
  ['snow', /\b(?:snow|snowy|snowing|blizzard)\b/i, /\b(?:no|not|without)\s+(?:\w+\s+){0,2}snow\b/i],
  ['cold', /\b(?:cold|freezing|chilly|below zero)\b/i, /\b(?:no|not)\s+(?:\w+\s+){0,2}cold\b/i],
  ['hot', /\b(?:hot|heatwave|heat wave|humid|scorching)\b/i, /\b(?:no|not)\s+(?:\w+\s+){0,2}hot\b/i],
];

/**
 * Conditions the traveller wrote down in their own words. Literal matching,
 * negation-aware ("no rain expected" states no rain). This reads what the
 * traveller SAID about the destination; it is never a forecast and never the
 * weather where the phone currently is.
 */
export function readStatedConditions(text: string | null): PackingCondition[] {
  if (!text) return [];
  const found: PackingCondition[] = [];
  for (const [condition, positive, negative] of CONDITION_PATTERNS) {
    if (positive.test(text) && !negative.test(text)) found.push(condition);
  }
  return found;
}
