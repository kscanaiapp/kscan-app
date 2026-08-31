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
} as const;

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
}

export interface PackingConstraints {
  /** Authoritative Closet ids the user has excluded for THIS trip only. */
  excludeItemIds: string[];
  packLight: boolean;
  /** Free-text refinement constraints ("no heels"). Untrusted data. */
  notes: string[];
}

export interface ParsedPackingRequest {
  ok: true;
  sessionId: string;
  trip: PackingTripInput;
  constraints: PackingConstraints;
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
      note: boundedText(trip.note, PACKING_LIMITS.maxNoteChars),
    },
    constraints: {
      excludeItemIds,
      packLight: rawConstraints.packLight === true,
      notes: constraintNotes,
    },
  };
}
