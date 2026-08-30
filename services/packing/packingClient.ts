// K+ Packing Intelligence V1 — Edge transport and wire validation.
//
// THE WIRE IS UNTRUSTED. Everything below re-validates the response before it
// becomes state, the same discipline edgeStyleChatProvider applies to weather
// context and advice metadata: what arrives is whatever the network produced,
// not necessarily what the server sent, and a screen that renders an unchecked
// payload is a screen that can render nonsense.
//
// The client never decides ownership. It receives a plan whose items the server
// already resolved against the traveller's own Closet rows, and its only
// addition is the local photograph matched by `clientId`.

import { supabase } from '../supabaseClient';
import {
  PACKING_ACTIVITIES,
  PACKING_REQUEST_SCHEMA_VERSION,
  type PackingActivity,
  type PackingGap,
  type PackingGeneralGuide,
  type PackingPlan,
  type PackingPlanItem,
  type PackingPlanOutfit,
  type PackingPlanWeather,
  type PackingResult,
  type PackingStatus,
  type PackingTripDraft,
  type PackingWeatherProvenance,
} from '../../types/packing';

const EDGE_FN = 'stylechat-generate';

/**
 * Longer than the chat timeout: the backend's own provider budget is 20s, and a
 * client timeout below that would abandon a generation the user has already
 * paid a quota unit for.
 */
const PACKING_TIMEOUT_MS = 30_000;

const MAX_ITEMS = 24;
const MAX_OUTFITS = 8;
const MAX_ITEMS_PER_OUTFIT = 6;
const MAX_ASSUMPTIONS = 5;
const MAX_GUIDE_SECTIONS = 8;
const MAX_GUIDE_ENTRIES = 10;

const PROVENANCES: PackingWeatherProvenance[] = ['FORECAST', 'SEASONAL', 'UNAVAILABLE'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function strList(value: unknown, maxItems: number, maxChars = 200): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = str(entry, maxChars);
    if (!text) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function parseActivity(value: unknown): PackingActivity | null {
  return typeof value === 'string' && (PACKING_ACTIVITIES as readonly string[]).includes(value)
    ? (value as PackingActivity)
    : null;
}

function parseWeather(value: unknown): PackingPlanWeather {
  if (!isRecord(value)) return { provenance: 'UNAVAILABLE', summary: null };
  const provenance = PROVENANCES.includes(value.provenance as PackingWeatherProvenance)
    ? (value.provenance as PackingWeatherProvenance)
    : 'UNAVAILABLE';
  // A summary without a provenance that justifies it is dropped rather than
  // shown: an unlabelled weather line is exactly the thing that reads as a
  // forecast when it is not one.
  const summary = provenance === 'UNAVAILABLE' ? null : str(value.summary, 160);
  return { provenance, summary };
}

function parseItem(value: unknown): PackingPlanItem | null {
  if (!isRecord(value)) return null;
  const itemId = str(value.itemId, 80);
  if (!itemId) return null;
  return {
    itemId,
    clientId: str(value.clientId, 200),
    title: str(value.title, 120) ?? 'Closet item',
    category: str(value.category, 80),
    subtype: str(value.subtype, 80),
    brand: str(value.brand, 120),
    primaryColor: str(value.primaryColor, 60),
    layeringRole: str(value.layeringRole, 40),
    reason: str(value.reason, 160),
    scarcitySignal: str(value.scarcitySignal, 60),
    usedInOutfits: int(value.usedInOutfits),
  };
}

function parseOutfit(value: unknown, index: number): PackingPlanOutfit | null {
  if (!isRecord(value)) return null;
  const itemIds = strList(value.itemIds, MAX_ITEMS_PER_OUTFIT, 80);
  if (itemIds.length === 0) return null;
  return {
    outfitId: str(value.outfitId, 80) ?? `outfit-${index}`,
    label: str(value.label, 60) ?? `Look ${index + 1}`,
    activity: parseActivity(value.activity),
    itemIds,
    reason: str(value.reason, 160),
  };
}

export function parsePackingPlan(value: unknown): PackingPlan | null {
  if (!isRecord(value)) return null;
  const trip = isRecord(value.trip) ? value.trip : null;
  const destination = trip ? str(trip.destination, 80) : null;
  const planId = str(value.planId, 80);
  if (!planId || !destination) return null;

  const packedItems: PackingPlanItem[] = [];
  const rawItems = Array.isArray(value.packedItems) ? value.packedItems : [];
  for (const raw of rawItems) {
    const item = parseItem(raw);
    if (!item) continue;
    if (packedItems.some((existing) => existing.itemId === item.itemId)) continue;
    packedItems.push(item);
    if (packedItems.length >= MAX_ITEMS) break;
  }
  if (packedItems.length === 0) return null;

  const packedIds = new Set(packedItems.map((item) => item.itemId));
  const outfits: PackingPlanOutfit[] = [];
  const rawOutfits = Array.isArray(value.outfits) ? value.outfits : [];
  for (const [index, raw] of rawOutfits.entries()) {
    const outfit = parseOutfit(raw, index);
    if (!outfit) continue;
    // An outfit referencing an item the packing list does not contain would
    // render a card with a missing tile. Trim rather than display a hole.
    const itemIds = outfit.itemIds.filter((id) => packedIds.has(id));
    if (itemIds.length === 0) continue;
    outfits.push({ ...outfit, itemIds });
    if (outfits.length >= MAX_OUTFITS) break;
  }
  if (outfits.length === 0) return null;

  // Reuse counts are RECOMPUTED from what will actually be rendered, so the
  // "works across 3 looks" badge can never overstate the plan on screen even if
  // the wire value drifted.
  const usage = new Map<string, number>();
  for (const outfit of outfits) {
    for (const id of outfit.itemIds) usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  for (const item of packedItems) item.usedInOutfits = usage.get(item.itemId) ?? 0;

  const constraints = isRecord(value.constraints) ? value.constraints : {};
  const gaps = parseGaps(value.gaps);

  return {
    contractVersion: str(value.contractVersion, 40) ?? '',
    planId,
    mode: value.mode === 'general' ? 'general' : 'personal',
    trip: {
      destination,
      startDate: str(trip?.startDate, 10) ?? '',
      endDate: str(trip?.endDate, 10) ?? '',
      nights: int(trip?.nights),
      tripType: str(trip?.tripType, 40) ?? 'other',
      activities: (Array.isArray(trip?.activities) ? trip?.activities : [])
        .map(parseActivity)
        .filter((activity): activity is PackingActivity => activity != null),
    },
    weather: parseWeather(value.weather),
    packedItems,
    outfits,
    gaps,
    assumptions: strList(value.assumptions, MAX_ASSUMPTIONS, 200),
    constraints: {
      excludedItemIds: strList(constraints.excludedItemIds, 40, 80),
      packLight: constraints.packLight === true,
      notes: strList(constraints.notes, 8, 300),
    },
    // Counts are DERIVED, never read from the wire: a header that disagrees
    // with the list below it is the exact class of inconsistency this feature
    // must not have.
    counts: {
      items: packedItems.length,
      outfits: outfits.length,
      shoes: packedItems.filter((item) => item.layeringRole === 'shoe').length,
      gaps: gaps.length,
    },
  };
}

export function parseGeneralGuide(value: unknown): PackingGeneralGuide | null {
  if (!isRecord(value)) return null;
  const rawSections = Array.isArray(value.sections) ? value.sections : [];
  const sections = [];
  for (const raw of rawSections) {
    if (!isRecord(raw)) continue;
    const label = str(raw.label, 60);
    const categories = strList(raw.categories, MAX_GUIDE_ENTRIES, 120);
    if (!label || categories.length === 0) continue;
    sections.push({ label, categories });
    if (sections.length >= MAX_GUIDE_SECTIONS) break;
  }
  if (sections.length === 0) return null;
  return { sections, notes: strList(value.notes, 5, 200) };
}

const MAX_GAPS = 3;

/**
 * A gap is a REQUIREMENT, and the client renders it in its own unowned
 * treatment. Anything shaped like commerce is dropped rather than displayed:
 * Packing V1 helps someone pack, and a payload that arrived carrying a price
 * or a link is not a payload this screen will show.
 */
function parseGaps(value: unknown): PackingGap[] {
  if (!Array.isArray(value)) return [];
  const gaps: PackingGap[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const code = str(raw.code, 60);
    const label = str(raw.label, 60);
    const rationale = str(raw.rationale, 200);
    if (!code || !label || !rationale) continue;
    if (raw.price != null || raw.url != null || raw.productId != null) continue;
    gaps.push({ code, label, rationale });
    if (gaps.length >= MAX_GAPS) break;
  }
  return gaps;
}

const STATUSES: PackingStatus[] = ['success', 'general_mode', 'not_entitled', 'no_result', 'error'];

export function parsePackingResponse(raw: unknown): PackingResult {
  if (!isRecord(raw)) {
    return {
      status: 'error',
      message: 'I could not finish your packing plan just now. Try again.',
      plan: null,
      generalGuide: null,
      errorCode: 'PACKING_BAD_RESPONSE',
      retryable: true,
    };
  }

  const status = STATUSES.includes(raw.status as PackingStatus)
    ? (raw.status as PackingStatus)
    : 'error';
  const errorCode = str(raw.errorCode, 60);
  const message =
    str(raw.message, 400) ?? 'I could not finish your packing plan just now. Try again.';

  const plan = status === 'success' ? parsePackingPlan(raw.plan) : null;

  // A success whose plan does not survive validation is NOT a success. Showing
  // an empty result under a success banner is the silent-failure mode section
  // Q of the build plan forbids.
  if (status === 'success' && !plan) {
    return {
      status: 'no_result',
      message: "I couldn't build a plan from your Closet for this trip yet.",
      plan: null,
      generalGuide: null,
      errorCode: 'PACKING_BAD_RESPONSE',
      retryable: true,
    };
  }

  return {
    status,
    message,
    plan,
    generalGuide: status === 'general_mode' ? parseGeneralGuide(raw.generalGuide) : null,
    errorCode,
    retryable: status === 'error' || status === 'no_result',
  };
}

export interface PackingRequestInput {
  sessionId: string;
  trip: PackingTripDraft;
  constraints?: {
    excludeItemIds?: string[];
    packLight?: boolean;
    notes?: string[];
  };
}

export async function requestPackingPlan(input: PackingRequestInput): Promise<PackingResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PACKING_TIMEOUT_MS);

  try {
    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body: {
        schemaVersion: PACKING_REQUEST_SCHEMA_VERSION,
        sessionId: input.sessionId,
        trip: {
          destination: input.trip.destination,
          startDate: input.trip.startDate,
          endDate: input.trip.endDate,
          tripType: input.trip.tripType,
          activities: input.trip.activities,
          ...(input.trip.note.trim() ? { note: input.trip.note.trim() } : {}),
        },
        ...(input.constraints ? { constraints: input.constraints } : {}),
      },
      signal: controller.signal,
    });

    if (error) {
      return {
        status: 'error',
        message: 'I could not reach K Scan to build your plan. Check your connection and try again.',
        plan: null,
        generalGuide: null,
        errorCode: 'PACKING_TRANSPORT_ERROR',
        retryable: true,
      };
    }

    return parsePackingResponse(data);
  } catch {
    return {
      status: 'error',
      message: 'Building your plan took too long. Your trip details are saved — try again.',
      plan: null,
      generalGuide: null,
      errorCode: 'PACKING_TIMEOUT',
      retryable: true,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
