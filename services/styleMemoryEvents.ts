// Privacy-clean AI Stylist feedback events.
//
// Reuses the existing style_memory_events foundation and its SECURITY DEFINER
// upsert_style_memory_event RPC (identity derived server-side from auth.uid()).
//
// What is stored: coarse event type, a stable signal key, a bounded payload of
// display-safe attributes (occasion, dress code, variation, rejection reason,
// item roles), and a conservative confidence weight.
//
// What is NEVER stored here:
//   - raw images or image URIs
//   - full closet dumps or prompts
//   - room participant/voter identities
//   - room comments
//
// Weighting principle (owner > room): explicit owner final choice > owner save
// > owner rejection > owner edit > room vote. Room feedback is advisory and
// recorded at low confidence; aggregation stays conservative in this build.

import { supabase } from './supabaseClient';

export const STYLE_MEMORY_SOURCE_AI_STYLIST = 'ai_stylist';

export const AI_STYLIST_EVENT_TYPES = [
  'ai_suggestion_viewed',
  'ai_suggestion_saved',
  'ai_suggestion_shared',
  'ai_item_swapped',
  'ai_suggestion_rejected',
  'room_option_voted',
  'owner_selected_winner',
  'owner_overrode_vote_leader',
  'owner_wearing_confirmed',
  'ai_look_edited',
] as const;
export type AiStylistEventType = (typeof AI_STYLIST_EVENT_TYPES)[number];

export const REJECTION_REASONS = [
  'too_formal',
  'too_casual',
  'not_my_style',
  'wrong_colors',
  'not_practical',
  'do_not_use_item',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const REJECTION_REASON_LABELS: Record<RejectionReason, string> = {
  too_formal: 'Too formal',
  too_casual: 'Too casual',
  not_my_style: 'Not my style',
  wrong_colors: 'Wrong colors',
  not_practical: 'Not practical',
  do_not_use_item: 'Do not use this item',
};

/** Owner actions outweigh room votes; keep values conservative. */
const EVENT_CONFIDENCE: Record<AiStylistEventType, number> = {
  owner_wearing_confirmed: 0.9,
  owner_selected_winner: 0.85,
  owner_overrode_vote_leader: 0.85,
  ai_suggestion_saved: 0.75,
  ai_suggestion_rejected: 0.6,
  ai_look_edited: 0.5,
  ai_item_swapped: 0.5,
  ai_suggestion_shared: 0.4,
  ai_suggestion_viewed: 0.2,
  room_option_voted: 0.25,
};

type BoundedPayload = Record<string, string | number | boolean | string[] | null>;

function boundPayload(payload: BoundedPayload): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (keys >= 12) break;
    if (typeof value === 'string') {
      bounded[key] = value.slice(0, 80);
    } else if (Array.isArray(value)) {
      bounded[key] = value.slice(0, 8).map((entry) => String(entry).slice(0, 40));
    } else {
      bounded[key] = value;
    }
    keys += 1;
  }
  return bounded;
}

/**
 * Records one privacy-clean stylist event. Fire-and-forget: failures never
 * interrupt the user flow (returns false instead of throwing).
 */
export async function recordAiStylistEvent(input: {
  eventType: AiStylistEventType;
  /** Stable dedup key, e.g. suggestionId, lookId, or groupId:optionId. */
  signalKey: string;
  payload?: BoundedPayload;
}): Promise<boolean> {
  const signalKey = String(input.signalKey ?? '').trim().slice(0, 120);
  if (!signalKey) return false;
  if (!AI_STYLIST_EVENT_TYPES.includes(input.eventType)) return false;

  try {
    const { error } = await supabase.rpc('upsert_style_memory_event', {
      p_source: STYLE_MEMORY_SOURCE_AI_STYLIST,
      p_event_type: input.eventType,
      p_signal_key: signalKey,
      p_signal_date: null,
      p_payload: boundPayload(input.payload ?? {}),
      p_confidence: EVENT_CONFIDENCE[input.eventType],
      p_source_refs: [],
    });
    if (error) {
      if (__DEV__) console.warn('[styleMemoryEvents] event_write_failed type=%s', input.eventType);
      return false;
    }
    return true;
  } catch {
    if (__DEV__) console.warn('[styleMemoryEvents] event_write_failed type=%s', input.eventType);
    return false;
  }
}
