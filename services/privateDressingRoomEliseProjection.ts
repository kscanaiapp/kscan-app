/**
 * The device-local Closet → an ephemeral, sanitized, request-scoped projection.
 *
 * PURE. No filesystem, no network, no React, no storage, no mutation of the
 * Closet, the session or the composition. Given projections and a request id it
 * returns a request body and the alias map that decodes the reply.
 *
 * THE ALIAS MAP IS THE WHOLE SECURITY MODEL. No Closet identifier crosses the
 * wire, so there is nothing for a response to name that the client did not
 * itself mint moments earlier. A returned alias is resolved by MEMBERSHIP in the
 * map this request built — not by shape, not by pattern, and never by falling
 * back to a raw Closet id, because no raw Closet id was ever sent to fall back
 * to. Absent from the map means the response is rejected outright.
 *
 * THE MAP IS ALSO EPHEMERAL. It is returned to the caller and held for the life
 * of one request. It is never serialized, never written to AsyncStorage or
 * SecureStore, never placed in the interaction record, and never sent to
 * analytics. `services/privateDressingRoomEliseClient.ts` owns its lifetime and
 * drops it on success, failure, timeout and cancellation alike.
 *
 * CANDIDATE SELECTION IS DETERMINISTIC AND EXISTING. Items are classified with
 * the production slot classifier, ordered by the existing slot display order,
 * and tie-broken by closetItemId — the composer's own tie-break. There is no
 * AI pre-ranking here and no new relevance model.
 */

import { classifyClosetItemSlot } from './privateDressingRoomSlots';
import type { ClosetItemProjection } from './closetItemProjection';
import { PRIVATE_SLOT_DISPLAY_ORDER } from '../types/privateDressingRoomComposition';
import type { PrivateDressingRoomSlot } from '../types/privateDressingRoomComposition';
import {
  PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
  PRIVATE_ELISE_BOUNDS,
  buildRequestAlias,
  type PrivateEliseCandidate,
  type PrivateEliseDressCode,
  type PrivateEliseOccasionGroup,
  type PrivateEliseRequest,
} from '../types/privateDressingRoomElise';

/** A request body plus the private map that can read its replies. */
export type ElisePlannedRequest = {
  requestId: string;
  body: PrivateEliseRequest;
  /** alias → closetItemId. Request-local. Never persisted. */
  aliases: Map<string, string>;
};

export type ElisePlanFailure = {
  reason: 'invalid_input' | 'no_candidates' | 'anchor_not_owned' | 'anchor_unsupported';
};

export type ElisePlanResult = { ok: true; plan: ElisePlannedRequest } | { ok: false } & ElisePlanFailure;

/**
 * Builds ONE sanitized candidate.
 *
 * Only fields the authoritative record actually carries are copied, and empty
 * values are omitted rather than sent as null — an omitted field says "this
 * garment has no recorded material", which is true, where `null` would invite
 * the reader to treat absence as data.
 */
function sanitizeCandidate(
  item: ClosetItemProjection,
  slot: PrivateDressingRoomSlot,
  ref: string,
  flags: { isAnchor?: boolean; isLocked?: boolean },
): PrivateEliseCandidate {
  const candidate: PrivateEliseCandidate = { ref, slot };
  if (item.category) candidate.category = item.category.slice(0, PRIVATE_ELISE_BOUNDS.category);
  if (item.clothingType) {
    candidate.clothingType = item.clothingType.slice(0, PRIVATE_ELISE_BOUNDS.clothingType);
  }
  if (item.subtype) candidate.subtype = item.subtype.slice(0, PRIVATE_ELISE_BOUNDS.subtype);
  if (item.primaryColor) candidate.color = item.primaryColor.slice(0, PRIVATE_ELISE_BOUNDS.color);
  if (Array.isArray(item.material) && item.material.length > 0) {
    candidate.material = item.material
      .slice(0, PRIVATE_ELISE_BOUNDS.materialCount)
      .map((value) => String(value).slice(0, PRIVATE_ELISE_BOUNDS.materialEntry));
  }
  if (flags.isAnchor) candidate.isAnchor = true;
  if (flags.isLocked) candidate.isLocked = true;
  return candidate;
}

/**
 * Chooses at most `PRIVATE_ELISE_BOUNDS.candidates` items, spread across slots.
 *
 * Round-robin over the existing display order rather than "first 20 sorted":
 * twenty tops describe a Closet no better than four tops and four pairs of
 * shoes, and a slot-blind cap on a large Closet can send a pool with no footwear
 * in it at all.
 */
function selectCandidates(
  items: readonly ClosetItemProjection[],
  anchorId: string | null,
): Array<{ item: ClosetItemProjection; slot: PrivateDressingRoomSlot }> {
  const bySlot = new Map<PrivateDressingRoomSlot, Array<ClosetItemProjection>>();
  let anchorEntry: { item: ClosetItemProjection; slot: PrivateDressingRoomSlot } | null = null;

  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    const slot = classifyClosetItemSlot(item).primarySlot;
    if (!slot) continue;
    if (anchorId && item.id === anchorId) {
      anchorEntry = { item, slot };
      continue;
    }
    const bucket = bySlot.get(slot);
    if (bucket) bucket.push(item);
    else bySlot.set(slot, [item]);
  }

  for (const bucket of bySlot.values()) {
    bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const selected: Array<{ item: ClosetItemProjection; slot: PrivateDressingRoomSlot }> = [];
  // The anchor is never a casualty of the cap: it is the thing being styled.
  if (anchorEntry) selected.push(anchorEntry);

  const cursors = new Map<PrivateDressingRoomSlot, number>();
  let exhausted = false;
  while (selected.length < PRIVATE_ELISE_BOUNDS.candidates && !exhausted) {
    exhausted = true;
    for (const slot of PRIVATE_SLOT_DISPLAY_ORDER) {
      if (selected.length >= PRIVATE_ELISE_BOUNDS.candidates) break;
      const bucket = bySlot.get(slot);
      if (!bucket) continue;
      const cursor = cursors.get(slot) ?? 0;
      if (cursor >= bucket.length) continue;
      selected.push({ item: bucket[cursor], slot });
      cursors.set(slot, cursor + 1);
      exhausted = false;
    }
  }
  return selected;
}

function boundedInstruction(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, PRIVATE_ELISE_BOUNDS.instruction);
}

function buildContext(input: {
  occasion?: string | null;
  occasionGroup?: PrivateEliseOccasionGroup | null;
  dressCode?: PrivateEliseDressCode | null;
}): PrivateEliseRequest['context'] {
  const context: NonNullable<PrivateEliseRequest['context']> = {};
  if (input.occasion && input.occasion.trim()) {
    context.occasion = input.occasion.trim().slice(0, PRIVATE_ELISE_BOUNDS.occasionText);
  }
  if (input.occasionGroup) context.occasionGroup = input.occasionGroup;
  if (input.dressCode) context.dressCode = input.dressCode;
  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * `interpret_occasion` — NO GARMENT POOL IS SENT.
 *
 * Classifying "dinner with clients" does not require knowing what the user owns,
 * so the Closet is not disclosed. This is the single largest privacy difference
 * between the two intents and it is deliberate.
 */
export function planOccasionRequest(input: {
  requestId: string;
  instruction: string;
  occasion?: string | null;
  occasionGroup?: PrivateEliseOccasionGroup | null;
  dressCode?: PrivateEliseDressCode | null;
}): ElisePlanResult {
  const instruction = boundedInstruction(input?.instruction);
  if (!instruction || typeof input?.requestId !== 'string' || !input.requestId) {
    return { ok: false, reason: 'invalid_input' };
  }
  const body: PrivateEliseRequest = {
    schemaVersion: PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
    requestId: input.requestId,
    intent: 'interpret_occasion',
    instruction,
  };
  const context = buildContext(input);
  if (context) body.context = context;
  return { ok: true, plan: { requestId: input.requestId, body, aliases: new Map() } };
}

/**
 * `build_around_item` — the anchor plus a bounded, slot-spread pool.
 *
 * OWNERSHIP IS PROVEN LOCALLY FIRST. The anchor must be present in this actor's
 * own loaded Closet and must classify to a slot the composer supports. Neither
 * check is delegated to the backend, which has no way to perform them: it never
 * sees a Closet.
 */
export function planAnchorRequest(input: {
  requestId: string;
  instruction: string;
  anchorClosetItemId: string;
  closetItems: readonly ClosetItemProjection[];
  occasion?: string | null;
  occasionGroup?: PrivateEliseOccasionGroup | null;
  dressCode?: PrivateEliseDressCode | null;
}): ElisePlanResult {
  const instruction = boundedInstruction(input?.instruction);
  if (!instruction || typeof input?.requestId !== 'string' || !input.requestId) {
    return { ok: false, reason: 'invalid_input' };
  }
  const anchorId = typeof input.anchorClosetItemId === 'string' ? input.anchorClosetItemId.trim() : '';
  if (!anchorId) return { ok: false, reason: 'invalid_input' };

  const items = Array.isArray(input.closetItems) ? input.closetItems : [];
  const owned = items.find((item) => item && item.id === anchorId) ?? null;
  if (!owned) return { ok: false, reason: 'anchor_not_owned' };
  if (!classifyClosetItemSlot(owned).primarySlot) {
    return { ok: false, reason: 'anchor_unsupported' };
  }

  const selected = selectCandidates(items, anchorId);
  if (selected.length === 0) return { ok: false, reason: 'no_candidates' };

  const aliases = new Map<string, string>();
  const candidates: PrivateEliseCandidate[] = [];
  selected.forEach((entry, index) => {
    const ref = buildRequestAlias(input.requestId, index + 1);
    aliases.set(ref, entry.item.id);
    candidates.push(
      sanitizeCandidate(entry.item, entry.slot, ref, {
        // The anchor is the only governed locked item in the current product
        // model, so isAnchor and isLocked coincide by construction. No other
        // slot is claimed to be locked.
        isAnchor: entry.item.id === anchorId,
        isLocked: entry.item.id === anchorId,
      }),
    );
  });

  const anchorRef = [...aliases.entries()].find(([, id]) => id === anchorId)?.[0];
  if (!anchorRef) return { ok: false, reason: 'anchor_not_owned' };

  const body: PrivateEliseRequest = {
    schemaVersion: PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
    requestId: input.requestId,
    intent: 'build_around_item',
    instruction,
    candidates,
    anchorRef,
    lockedRefs: [anchorRef],
  };
  const context = buildContext(input);
  if (context) body.context = context;
  return { ok: true, plan: { requestId: input.requestId, body, aliases } };
}

/** Resolves a returned alias. Absent from the map is a rejection, not a miss. */
export function resolveAlias(plan: ElisePlannedRequest, alias: unknown): string | null {
  if (typeof alias !== 'string') return null;
  return plan.aliases.get(alias) ?? null;
}

// ── Staleness ────────────────────────────────────────────────────────────────

/**
 * The context a response must still match to be applied.
 *
 * Captured when the request STARTS and compared when it RETURNS. Cancellation
 * alone is not enough: an in-flight fetch can resolve after the state it was
 * computed for is gone, and the only durable defence is to compare.
 */
export type EliseLifecycleSnapshot = {
  actorId: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  compositionFingerprint: string | null;
  activeLookId: string | null;
};

export const ELISE_STALE_REASONS = [
  'superseded',
  'route_unmounted',
  'actor_changed',
  'session_changed',
  'session_discarded',
  'composition_changed',
  'look_changed',
] as const;
export type EliseStaleReason = (typeof ELISE_STALE_REASONS)[number];

export type EliseCurrencyResult =
  | { current: true }
  | { current: false; reason: EliseStaleReason };

/**
 * Narrows a stale result. See isEliseResponseFailure in the contract for why a
 * predicate is needed rather than `if (!result.current)`: this repository does
 * not enable `strictNullChecks`, so boolean discriminants do not narrow.
 */
export function isStaleCurrency(
  result: EliseCurrencyResult,
): result is { current: false; reason: EliseStaleReason } {
  return result.current === false;
}

/**
 * Is this response still allowed to change anything?
 *
 * PURE and total. Every rejection reason is named, so a stale response is
 * diagnosable rather than silently dropped.
 */
export function evaluateResponseCurrency(input: {
  requestGeneration: number;
  currentGeneration: number;
  routeMounted: boolean;
  atRequest: EliseLifecycleSnapshot;
  now: EliseLifecycleSnapshot;
  /** Only compared when the intent's result depends on the selected look. */
  compareActiveLook?: boolean;
}): EliseCurrencyResult {
  if (input.requestGeneration !== input.currentGeneration) {
    return { current: false, reason: 'superseded' };
  }
  if (!input.routeMounted) return { current: false, reason: 'route_unmounted' };

  const before = input.atRequest;
  const after = input.now;
  if (before.actorId !== after.actorId) return { current: false, reason: 'actor_changed' };
  if (before.sessionId !== after.sessionId) return { current: false, reason: 'session_changed' };
  if (after.sessionStatus !== 'active' || before.sessionStatus !== after.sessionStatus) {
    return { current: false, reason: 'session_discarded' };
  }
  if (before.compositionFingerprint !== after.compositionFingerprint) {
    return { current: false, reason: 'composition_changed' };
  }
  if (input.compareActiveLook && before.activeLookId !== after.activeLookId) {
    return { current: false, reason: 'look_changed' };
  }
  return { current: true };
}
