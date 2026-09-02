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

export interface PackingTripDraft {
  destination: string;
  startDate: string;
  endDate: string;
  tripType: PackingTripType;
  activities: PackingActivity[];
  note: string;
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
}

export interface PackingPlanOutfit {
  outfitId: string;
  label: string;
  activity: PackingActivity | null;
  itemIds: string[];
  reason: string | null;
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
}
