// Mobile client for the style-outfit-generate Edge Function.
//
// Behavior contract (Part 15–17 of the AI Stylist expansion):
//   * Every call checks the local feature gate first; the function is NOT
//     deployed during this build, so unavailable-service handling is a
//     first-class outcome, not an exception.
//   * One in-flight guard per generation flow; rapid taps reuse the guard.
//   * ~30s in-memory cooldown after unavailable-service failures prevents
//     endpoint hammering.
//   * The client never sends candidate closet arrays — only the mode, an
//     optional anchor/keep/exclude reference set, and event context.
//   * Responses are shape-validated before use; malformed payloads become a
//     safe error, never a crash.
//   * Metadata-only logging: no notes, closet content, or images.

import { supabase } from './supabaseClient';
import { resolveAuthenticatedFunctionSession } from './authenticatedFunctionSession';
import {
  AI_STYLIST_BACKEND_ENABLED,
  AI_STYLIST_UI_ENABLED,
} from '../constants/featureFlags';
import {
  FASHION_REASONING_CONTRACT_VERSION,
  MAX_OUTFIT_ITEMS,
  MAX_OUTFIT_SUGGESTIONS,
  MIN_OUTFIT_ITEMS,
  OUTFIT_VARIATIONS,
  isGarmentRole,
  isOutfitVariation,
  type GarmentRole,
  type OutfitOccasion,
  type OutfitDressCode,
  type OutfitSetting,
  type OutfitVariation,
  type StyleOutfitMode,
} from '../types/fashionReasoning';
import type { OwnedItemRef } from '../types/ownedClosetItem';

export const STYLE_OUTFIT_FUNCTION_NAME = 'style-outfit-generate';
export const UNAVAILABLE_COOLDOWN_MS = 30_000;

export const AI_UNAVAILABLE_MESSAGE =
  "Elise isn't available right now. Build a Look manually or try again later.";
export const AI_QUOTA_MESSAGE =
  "You've reached today's styling limit. Try again tomorrow or build a Look manually.";
export const AI_BURST_MESSAGE = 'A moment between requests, please — try again shortly.';
export const AI_NO_RESULT_MESSAGE = "Elise couldn't build a complete option from your closet yet.";
export const AI_SESSION_EXPIRED_MESSAGE =
  'Your session expired. Sign in again to ask Elise.';

export type StyleOutfitEvent = {
  occasion?: OutfitOccasion | null;
  dressCode?: OutfitDressCode | null;
  setting?: OutfitSetting | null;
  note?: string | null;
};

export type StyleOutfitRequest = {
  mode: StyleOutfitMode;
  anchorItem?: OwnedItemRef | null;
  keepItems?: OwnedItemRef[];
  excludeItems?: OwnedItemRef[];
  event?: StyleOutfitEvent;
  maximumOutfits?: number;
};

export type OutfitSuggestionItemRef = {
  sourceType: 'saved_scan' | 'inspiration_item';
  sourceId: string;
  role: GarmentRole;
  position: number;
};

export type OutfitSuggestion = {
  suggestionId: string;
  variation: OutfitVariation;
  itemRefs: OutfitSuggestionItemRef[];
  reason: string;
  confidence: 'high' | 'medium' | 'low';
};

export type StyleOutfitResult =
  | { status: 'success'; requestId: string; outfits: OutfitSuggestion[] }
  | { status: 'no_result'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'quota_exceeded'; message: string }
  | { status: 'burst_limit'; message: string; retryAfterSeconds: number }
  | { status: 'session_expired'; message: string }
  | { status: 'error'; message: string };

// ── Module-level guards (in-memory, per JS runtime) ───────────────────────────

let inFlight = false;
let unavailableUntil = 0;

export function isGenerationInFlight(): boolean {
  return inFlight;
}

export function isInUnavailableCooldown(now: number = Date.now()): boolean {
  return now < unavailableUntil;
}

/** Test seam: reset module guards. */
export function __resetStyleOutfitGuards(): void {
  inFlight = false;
  unavailableUntil = 0;
}

function markUnavailable(now: number = Date.now()): void {
  unavailableUntil = now + UNAVAILABLE_COOLDOWN_MS;
}

// ── Response validation (client side; server already validated ownership) ────

function parseSuggestion(raw: unknown): OutfitSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (!isOutfitVariation(record.variation)) return null;
  if (!Array.isArray(record.itemRefs)) return null;
  if (record.itemRefs.length < MIN_OUTFIT_ITEMS || record.itemRefs.length > MAX_OUTFIT_ITEMS) return null;

  const itemRefs: OutfitSuggestionItemRef[] = [];
  const seen = new Set<string>();
  for (const rawItem of record.itemRefs) {
    if (!rawItem || typeof rawItem !== 'object') return null;
    const item = rawItem as Record<string, unknown>;
    const sourceType = item.sourceType;
    if (sourceType !== 'saved_scan' && sourceType !== 'inspiration_item') return null;
    const sourceId = typeof item.sourceId === 'string' ? item.sourceId : '';
    if (!sourceId) return null;
    const key = `${sourceType}:${sourceId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    itemRefs.push({
      sourceType,
      sourceId,
      role: isGarmentRole(item.role) ? item.role : 'other',
      position: itemRefs.length,
    });
  }

  return {
    suggestionId: typeof record.suggestionId === 'string' ? record.suggestionId : `${Date.now()}-${itemRefs.length}`,
    variation: record.variation as OutfitVariation,
    itemRefs,
    reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : 'A combination from your closet.',
    confidence:
      record.confidence === 'high' || record.confidence === 'medium' || record.confidence === 'low'
        ? record.confidence
        : 'medium',
  };
}

function parseSuccessPayload(payload: Record<string, unknown>): StyleOutfitResult {
  const rawOutfits = Array.isArray(payload.outfits) ? payload.outfits : [];
  const parsed = rawOutfits
    .map(parseSuggestion)
    .filter((suggestion): suggestion is OutfitSuggestion => suggestion !== null);

  // Enforce canonical variation order on the client as well.
  const ordered = OUTFIT_VARIATIONS
    .map((variation) => parsed.find((suggestion) => suggestion.variation === variation))
    .filter((suggestion): suggestion is OutfitSuggestion => !!suggestion)
    .slice(0, MAX_OUTFIT_SUGGESTIONS);

  if (ordered.length === 0) {
    return { status: 'no_result', message: AI_NO_RESULT_MESSAGE };
  }
  return {
    status: 'success',
    requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
    outfits: ordered,
  };
}

function sanitizeRef(ref?: OwnedItemRef | null) {
  if (!ref || !ref.sourceId) return null;
  return { sourceType: ref.sourceType, sourceId: ref.sourceId };
}

/**
 * Requests outfit suggestions. Never throws for expected service conditions —
 * every failure mode maps to a typed result so screens can render calm
 * fallbacks and keep the manual builder reachable.
 */
export async function generateOutfits(request: StyleOutfitRequest): Promise<StyleOutfitResult> {
  if (!AI_STYLIST_UI_ENABLED || !AI_STYLIST_BACKEND_ENABLED) {
    return { status: 'unavailable', message: AI_UNAVAILABLE_MESSAGE };
  }
  if (isInUnavailableCooldown()) {
    return { status: 'unavailable', message: AI_UNAVAILABLE_MESSAGE };
  }
  if (inFlight) {
    return { status: 'error', message: 'A styling request is already running.' };
  }

  inFlight = true;
  try {
    const auth = await resolveAuthenticatedFunctionSession();
    if (!auth.ok) {
      return { status: 'session_expired', message: AI_SESSION_EXPIRED_MESSAGE };
    }

    const body = {
      mode: request.mode,
      anchorItem: sanitizeRef(request.anchorItem),
      keepItems: (request.keepItems ?? []).map(sanitizeRef).filter(Boolean),
      excludeItems: (request.excludeItems ?? []).map(sanitizeRef).filter(Boolean),
      event: {
        occasion: request.event?.occasion ?? null,
        dressCode: request.event?.dressCode ?? null,
        setting: request.event?.setting ?? null,
        note: request.event?.note?.trim() ? request.event.note.trim().slice(0, 280) : null,
      },
      maximumOutfits: Math.max(1, Math.min(request.maximumOutfits ?? MAX_OUTFIT_SUGGESTIONS, MAX_OUTFIT_SUGGESTIONS)),
      contractVersion: FASHION_REASONING_CONTRACT_VERSION,
    };

    const { data, error } = await supabase.functions.invoke(STYLE_OUTFIT_FUNCTION_NAME, { body });

    if (error) {
      // Function not found / 404 / 503 / network failure / timeout → cooldown.
      markUnavailable();
      if (__DEV__) console.warn('[styleOutfits] invoke_failed');
      return { status: 'unavailable', message: AI_UNAVAILABLE_MESSAGE };
    }

    const payload = (data ?? {}) as Record<string, unknown>;
    const status = typeof payload.status === 'string' ? payload.status : '';

    switch (status) {
      case 'success':
        return parseSuccessPayload(payload);
      case 'no_result':
        return { status: 'no_result', message: AI_NO_RESULT_MESSAGE };
      case 'disabled':
        markUnavailable();
        return { status: 'unavailable', message: AI_UNAVAILABLE_MESSAGE };
      case 'quota_exceeded':
        return { status: 'quota_exceeded', message: AI_QUOTA_MESSAGE };
      case 'burst_limit': {
        const retryAfterSeconds =
          typeof payload.retryAfterSeconds === 'number' && payload.retryAfterSeconds > 0
            ? Math.ceil(payload.retryAfterSeconds)
            : 60;
        return { status: 'burst_limit', message: AI_BURST_MESSAGE, retryAfterSeconds };
      }
      case 'provider_unavailable':
        markUnavailable();
        return { status: 'unavailable', message: AI_UNAVAILABLE_MESSAGE };
      default:
        // Invalid/unknown server payload: safe error, no crash, cooldown.
        markUnavailable();
        if (__DEV__) console.warn('[styleOutfits] invalid_payload');
        return { status: 'unavailable', message: AI_UNAVAILABLE_MESSAGE };
    }
  } catch {
    markUnavailable();
    if (__DEV__) console.warn('[styleOutfits] unexpected_failure');
    return { status: 'unavailable', message: AI_UNAVAILABLE_MESSAGE };
  } finally {
    inFlight = false;
  }
}
