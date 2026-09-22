// K+ Packing Intelligence V1 — client-side plan contract.
//
// This mirrors the backend's packingValidation.ts plan shape, but the client
// NEVER trusts the wire: parsePackingResponse (services/packing/packingClient)
// re-validates every field before anything becomes state. What arrives is
// whatever the network produced, not necessarily what the server sent.
//
// The client's job with a plan is to RENDER it. It does not compute ownership,
// does not fill gaps, and does not invent items -- the server already decided
// what the traveller owns, and the only thing the device adds is the
// traveller's own photograph, matched by `clientId` against the local Closet.

export const PACKING_CONTRACT_VERSION = 'packing_plan_v1';
export const PACKING_REQUEST_SCHEMA_VERSION = 'packing-plan-v1';

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

export const PACKING_TRIP_TYPE_LABELS: Record<PackingTripType, string> = {
  leisure: 'Leisure',
  business: 'Business',
  beach: 'Beach',
  city: 'City',
  outdoors: 'Outdoors',
  event: 'Event',
  other: 'Other',
};

export type PackingWeatherProvenance = 'FORECAST' | 'SEASONAL' | 'UNAVAILABLE';

/** Build 35. The day-by-day trip planner the client asks the server for. */
export const PACKING_PLANNER_VERSION = 2;
export const PACKING_MAX_ACTIVITIES_PER_DAY = 3;

export interface PackingDayScheduleDraft {
  date: string;
  activities: PackingActivity[];
}

export interface PackingTripDraft {
  destination: string;
  startDate: string;
  endDate: string;
  tripType: PackingTripType;
  activities: PackingActivity[];
  note: string;
  /**
   * Build 35. Occasions per day, when the traveller set them. Absent means the
   * server derives a schedule and says so in the plan's assumptions.
   */
  schedule?: PackingDayScheduleDraft[];
}

export type PackingSlotCoverage = 'covered' | 'unconfirmed' | 'uncovered';

export interface PackingPlanDaySlot {
  slotId: string;
  activity: PackingActivity;
  formalityShift: 'less_formal' | 'more_formal' | null;
  label: string;
  outfitId: string | null;
  coverage: PackingSlotCoverage;
  missing: string[];
  /** The traveller asked to keep this look exactly as it is. */
  pinned: boolean;
  /** A later day re-wearing an earlier look. */
  repeatsSlotId: string | null;
}

export interface PackingPlanDay {
  dayIndex: number;
  date: string;
  label: string;
  slots: PackingPlanDaySlot[];
}

/** A packed-elsewhere piece the planner decided can stay home. */
export interface PackingLeftHomeItem {
  itemId: string;
  title: string;
  coveredByItemId: string | null;
  coveredByTitle: string | null;
}

/**
 * NOT OWNED. A category-level idea for a confirmed gap, shown only when the
 * traveller asked to shop. No item id, no product, no price, no link -- and the
 * relationship is fixed so it can never be rendered as something packed.
 */
export interface PackingExternalSuggestion {
  gapCode: string;
  label: string;
  relationship: 'external';
}

export interface PackingClarificationOption {
  kind: 'item' | 'day';
  value: string;
  label: string;
}

export interface PackingClarification {
  question: string;
  options: PackingClarificationOption[];
}

export interface PackingPlanItem {
  itemId: string;
  clientId: string | null;
  title: string;
  category: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  layeringRole: string | null;
  reason: string | null;
  /** Server-derived Closet fact ('Your only outer layer'), never a model claim. */
  scarcitySignal: string | null;
  usedInOutfits: number;
  /** Build 35. Only `owned` can ever be packed; the parser drops anything else. */
  ownership?: 'owned';
}

export interface PackingPlanOutfit {
  outfitId: string;
  label: string;
  activity: PackingActivity | null;
  itemIds: string[];
  reason: string | null;
  slotId?: string;
  date?: string;
  coverage?: PackingSlotCoverage;
}

/**
 * A requirement this trip has that the Closet cannot meet. NEVER a product,
 * never a price, never a retailer -- and never rendered with owned-item
 * styling, which is the whole point of keeping it a separate type.
 */
export interface PackingGap {
  code: string;
  label: string;
  rationale: string;
  /** Build 35. `unconfirmed` means "I can't tell", never "you don't have". */
  certainty?: 'confirmed' | 'unconfirmed';
}

export interface PackingPlanWeather {
  provenance: PackingWeatherProvenance;
  summary: string | null;
  /**
   * The place the forecast is actually FOR, as the geocoder resolved it
   * (PK-002). Null when no forecast was resolved. The traveller types a
   * destination; the provider silently picks one match, and "Springfield",
   * "Portland" and "Georgia" all resolve somewhere they may not have meant.
   */
  resolvedLocation: string | null;
}

export interface PackingPlanChange {
  slotId: string;
  removedItemIds: string[];
  addedItemIds: string[];
}

export interface PackingPlan {
  contractVersion: string;
  planId: string;
  mode: 'personal' | 'general';
  trip: {
    destination: string;
    startDate: string;
    endDate: string;
    nights: number;
    tripType: string;
    activities: PackingActivity[];
  };
  weather: PackingPlanWeather;
  packedItems: PackingPlanItem[];
  outfits: PackingPlanOutfit[];
  gaps: PackingGap[];
  assumptions: string[];
  constraints: {
    excludedItemIds: string[];
    packLight: boolean;
    notes: string[];
  };
  counts: {
    items: number;
    outfits: number;
    shoes: number;
    gaps: number;
  };
  /** Build 35 planner fields. All optional: a V1 plan has none of them. */
  plannerVersion?: 2;
  days?: PackingPlanDay[];
  notes?: string[];
  leftHome?: PackingLeftHomeItem[];
  considerBuying?: PackingExternalSuggestion[];
  /**
   * Build 35. Looks the last refinement changed, as ids only: what left and
   * what arrived. The screen marks those looks instead of asking the traveller
   * to re-read the whole plan. Empty for a new plan.
   */
  changes?: PackingPlanChange[];
  /**
   * Opaque structured plan state. The client stores it and hands it back on
   * the next refinement; it never reads ownership from it, and the server
   * re-verifies every id in it against the actor's Closet.
   */
  state?: Record<string, unknown> | null;
}

export interface PackingGeneralGuideSection {
  label: string;
  categories: string[];
}

export interface PackingGeneralGuide {
  sections: PackingGeneralGuideSection[];
  notes: string[];
}

export type PackingStatus =
  | 'success'
  | 'general_mode'
  | 'not_entitled'
  | 'no_result'
  | 'error';

export interface PackingResult {
  status: PackingStatus;
  message: string;
  plan: PackingPlan | null;
  generalGuide: PackingGeneralGuide | null;
  errorCode: string | null;
  /** True when retrying the same trip is worth offering. */
  retryable: boolean;
  /** Build 35. A question the traveller must answer before anything changes. */
  clarification?: PackingClarification | null;
}
