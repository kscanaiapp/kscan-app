/**
 * Private Dressing Room composition identifiers, fingerprints, allowlisted
 * record construction, and validation.
 *
 * Every function here is PURE and never mutates its input. Validation
 * RECONSTRUCTS through the allowlist rather than editing the raw value, so a
 * hostile or future record cannot carry an unknown key forward simply by being
 * on disk.
 *
 * NO MIGRATION EXISTS, deliberately. This domain is greenfield. Collaborative
 * room outfits, free-tier generated outfits, Saved Looks and saved scans are
 * SEPARATE DOMAINS with their own identity rules — importing any of them here
 * would silently make this store responsible for data it does not own.
 */

import * as ExpoCrypto from 'expo-crypto';
import {
  PRIVATE_COMPOSITION_SCHEMA_VERSION,
  PRIVATE_COMPOSITION_MAX_SUPPORTED_SCHEMA_VERSION,
  PRIVATE_COMPOSER_VERSION,
  PRIVATE_COMPOSITION_BOUNDS,
  PRIVATE_SLOTS,
  isPrivateSlot,
  isPrivateLookLabelCode,
} from '../types/privateDressingRoomComposition';
import type {
  PrivateDressingRoomCompositionSet,
  PrivateDressingRoomLookOption,
  PrivateDressingRoomOutfitItem,
  PrivateCompositionErrorCode,
  PrivateDressingRoomSlot,
} from '../types/privateDressingRoomComposition';

let compositionIdCounter = 0;
let lookIdCounter = 0;

// ── Identifiers ──────────────────────────────────────────────────────────────

/**
 * Mirrors services/privateDressingRoomSessionSchema.ts#randomSuffix, which in
 * turn mirrors services/closetCandidateSchema.js. Web Crypto -> expo-crypto ->
 * Math.random, because Hermes may ship without global Web Crypto.
 */
function randomSuffix(): string {
  try {
    const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
      .crypto;
    if (crypto && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }
  try {
    if (typeof ExpoCrypto.getRandomBytes === 'function') {
      const bytes = ExpoCrypto.getRandomBytes(8);
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(36);
  return `${rand()}${rand()}`;
}

export function createCompositionId(): string {
  compositionIdCounter = (compositionIdCounter + 1) % 0x100000;
  return `drcomp_${Date.now().toString(36)}_${compositionIdCounter.toString(36)}_${randomSuffix()}`;
}

/**
 * Look ids are minted per composition and are NOT derived from item contents.
 *
 * A content-derived id would make two runs that happen to produce the same
 * garments indistinguishable, which is exactly the case where "is this the look
 * the user selected?" must still have a definite answer.
 */
export function createLookId(): string {
  lookIdCounter = (lookIdCounter + 1) % 0x100000;
  return `drlook_${Date.now().toString(36)}_${lookIdCounter.toString(36)}_${randomSuffix()}`;
}

// ── Field hygiene ────────────────────────────────────────────────────────────

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeActorId(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, PRIVATE_COMPOSITION_BOUNDS.actorId)
    : null;
}

function cleanTimestamp(value: unknown): string | null {
  const text = cleanText(value, 40);
  if (!text) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

// ── Occasion normalization ───────────────────────────────────────────────────

/**
 * The normalized occasion KEY, used for fingerprinting and ranking.
 *
 * The user's typed text is never replaced — this is a lookup key derived from
 * it. Case and surrounding whitespace are insignificant; everything else is
 * preserved so two visibly different occasions cannot collapse into one
 * fingerprint.
 */
export function normalizeOccasionKey(occasion: unknown): string {
  const text = cleanText(occasion, PRIVATE_COMPOSITION_BOUNDS.closetItemId);
  if (!text) return '';
  return text.toLowerCase().replace(/\s+/g, ' ');
}

// ── Input fingerprint ────────────────────────────────────────────────────────

/**
 * Bind a composition to the exact session context that produced it.
 *
 * WHY THIS EXISTS INSTEAD OF A TRANSACTION. Session and composition live in two
 * files. Changing an anchor means updating one and replacing the other, and
 * there is no cross-file atomic write available — so a crash between them is
 * always possible. Rather than pretend otherwise, validity is DERIVED: a
 * composition is current only while its fingerprint still matches the live
 * session. A stale composition file that survives a failed cleanup can never be
 * shown under the new context, because the context it names no longer exists.
 *
 * `status` participates so a discarded session invalidates its composition
 * without any cleanup running at all.
 */
export function buildCompositionFingerprint(input: {
  actorId: string | null;
  sessionId: string;
  status: string;
  anchorClosetItemId?: string | null;
  occasion?: string | null;
}): string {
  const parts = [
    `composer:v${PRIVATE_COMPOSER_VERSION}`,
    `actor:${normalizeActorId(input.actorId) ?? ''}`,
    `session:${cleanText(input.sessionId, PRIVATE_COMPOSITION_BOUNDS.sessionId) ?? ''}`,
    `status:${cleanText(input.status, 40) ?? ''}`,
    `anchor:${cleanText(input.anchorClosetItemId, PRIVATE_COMPOSITION_BOUNDS.closetItemId) ?? ''}`,
    `occasion:${normalizeOccasionKey(input.occasion)}`,
  ];
  return parts.join('|').slice(0, PRIVATE_COMPOSITION_BOUNDS.inputFingerprint);
}

// ── Validation ───────────────────────────────────────────────────────────────

export type PrivateCompositionValidation = {
  ok: boolean;
  record: PrivateDressingRoomCompositionSet | null;
  errorCode: PrivateCompositionErrorCode | null;
};

function invalid(errorCode: PrivateCompositionErrorCode): PrivateCompositionValidation {
  return { ok: false, record: null, errorCode };
}

function validateOutfitItem(raw: unknown): PrivateDressingRoomOutfitItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (!isPrivateSlot(entry.slot)) return null;
  const closetItemId = cleanText(entry.closetItemId, PRIVATE_COMPOSITION_BOUNDS.closetItemId);
  if (!closetItemId) return null;
  return { slot: entry.slot, closetItemId };
}

function validateLook(
  raw: unknown,
  sessionId: string,
): PrivateDressingRoomLookOption | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  const lookId = cleanText(entry.lookId, PRIVATE_COMPOSITION_BOUNDS.lookId);
  if (!lookId) return null;

  // A look that names a different session is not this composition's look.
  const lookSession = cleanText(entry.sessionId, PRIVATE_COMPOSITION_BOUNDS.sessionId);
  if (!lookSession || lookSession !== sessionId) return null;

  if (!Array.isArray(entry.items) || entry.items.length === 0) return null;
  if (entry.items.length > PRIVATE_COMPOSITION_BOUNDS.itemsPerLook) return null;

  const items: PrivateDressingRoomOutfitItem[] = [];
  const seenSlots = new Set<string>();
  const seenItems = new Set<string>();
  for (const rawItem of entry.items) {
    const item = validateOutfitItem(rawItem);
    if (!item) return null;
    // One garment per slot, and one slot per garment: an item filling two roles
    // in the same outfit is not an outfit the user could wear.
    if (seenSlots.has(item.slot)) return null;
    if (seenItems.has(item.closetItemId)) return null;
    seenSlots.add(item.slot);
    seenItems.add(item.closetItemId);
    items.push(item);
  }

  const completeness = entry.completeness;
  if (completeness !== 'complete' && completeness !== 'partial') return null;

  if (!Array.isArray(entry.missingSlots)) return null;
  const missingSlots: PrivateDressingRoomSlot[] = [];
  for (const slot of entry.missingSlots) {
    if (!isPrivateSlot(slot)) return null;
    // A slot cannot be both filled and missing.
    if (seenSlots.has(slot)) return null;
    if (!missingSlots.includes(slot)) missingSlots.push(slot);
  }
  // Truthfulness: a complete look has nothing missing, and a partial look must
  // say what. Neither is allowed to lie about the other.
  if (completeness === 'complete' && missingSlots.length > 0) return null;
  if (completeness === 'partial' && missingSlots.length === 0) return null;

  if (!Array.isArray(entry.labelCodes)) return null;
  const labelCodes = [];
  for (const code of entry.labelCodes) {
    if (!isPrivateLookLabelCode(code)) return null;
    if (!labelCodes.includes(code)) labelCodes.push(code);
  }

  const rank = entry.rank;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0) return null;

  return { lookId, sessionId, items, completeness, missingSlots, labelCodes, rank };
}

/**
 * Validate one raw persisted composition and RECONSTRUCT it through the
 * allowlist.
 *
 * Fails CLOSED on every structural violation rather than repairing: a
 * composition that has to be guessed at is one that would show the user an
 * outfit the composer never produced.
 */
export function validateCompositionRecord(raw: unknown): PrivateCompositionValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('composition_store_corrupt');
  }
  const record = raw as Record<string, unknown>;

  const version = record.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) {
    return invalid('composition_store_corrupt');
  }
  if (version > PRIVATE_COMPOSITION_MAX_SUPPORTED_SCHEMA_VERSION) {
    return invalid('composition_store_future_schema');
  }

  // The composer version is a behavioural contract, not a storage one: a set
  // built by a different algorithm is refused rather than reinterpreted.
  if (record.composerVersion !== PRIVATE_COMPOSER_VERSION) {
    return invalid(
      typeof record.composerVersion === 'number' &&
        record.composerVersion > PRIVATE_COMPOSER_VERSION
        ? 'composition_store_future_schema'
        : 'composition_store_corrupt',
    );
  }

  const compositionId = cleanText(record.compositionId, PRIVATE_COMPOSITION_BOUNDS.compositionId);
  const sessionId = cleanText(record.sessionId, PRIVATE_COMPOSITION_BOUNDS.sessionId);
  const inputFingerprint = cleanText(
    record.inputFingerprint,
    PRIVATE_COMPOSITION_BOUNDS.inputFingerprint,
  );
  if (!compositionId || !sessionId || !inputFingerprint) {
    return invalid('composition_store_corrupt');
  }

  const createdAt = cleanTimestamp(record.createdAt);
  const updatedAt = cleanTimestamp(record.updatedAt);
  if (!createdAt || !updatedAt) return invalid('composition_store_corrupt');

  if (!Array.isArray(record.looks)) return invalid('composition_store_corrupt');
  if (
    record.looks.length < PRIVATE_COMPOSITION_BOUNDS.minLooks ||
    record.looks.length > PRIVATE_COMPOSITION_BOUNDS.maxLooks
  ) {
    return invalid('composition_store_corrupt');
  }

  const looks: PrivateDressingRoomLookOption[] = [];
  const seenLookIds = new Set<string>();
  const seenRanks = new Set<number>();
  const seenItemSets = new Set<string>();
  for (const rawLook of record.looks) {
    const look = validateLook(rawLook, sessionId);
    if (!look) return invalid('composition_store_corrupt');
    if (seenLookIds.has(look.lookId)) return invalid('composition_store_corrupt');
    if (seenRanks.has(look.rank)) return invalid('composition_store_corrupt');
    // Two looks over the identical garment set are the same outfit shown twice.
    const itemSetKey = look.items
      .map((item) => item.closetItemId)
      .slice()
      .sort()
      .join('+');
    if (seenItemSets.has(itemSetKey)) return invalid('composition_store_corrupt');
    seenLookIds.add(look.lookId);
    seenRanks.add(look.rank);
    seenItemSets.add(itemSetKey);
    looks.push(look);
  }

  const activeLookId = cleanText(record.activeLookId, PRIVATE_COMPOSITION_BOUNDS.lookId);
  if (activeLookId && !seenLookIds.has(activeLookId)) {
    return invalid('composition_store_corrupt');
  }

  return {
    ok: true,
    errorCode: null,
    record: {
      compositionId,
      actorId: normalizeActorId(record.actorId),
      sessionId,
      inputFingerprint,
      composerVersion: PRIVATE_COMPOSER_VERSION,
      activeLookId: activeLookId ?? null,
      looks,
      createdAt,
      updatedAt,
      schemaVersion: PRIVATE_COMPOSITION_SCHEMA_VERSION,
    },
  };
}

// ── Construction ─────────────────────────────────────────────────────────────

/** Build a fresh composition set. `createdAt` is never rewritten afterwards. */
export function buildCompositionSet(input: {
  actorId: string | null;
  sessionId: string;
  inputFingerprint: string;
  looks: PrivateDressingRoomLookOption[];
  activeLookId?: string | null;
  now?: string;
}): PrivateDressingRoomCompositionSet {
  const timestamp = cleanTimestamp(input.now) ?? new Date().toISOString();
  return {
    compositionId: createCompositionId(),
    actorId: normalizeActorId(input.actorId),
    sessionId: input.sessionId,
    inputFingerprint: input.inputFingerprint,
    composerVersion: PRIVATE_COMPOSER_VERSION,
    activeLookId: input.activeLookId ?? null,
    looks: input.looks,
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: PRIVATE_COMPOSITION_SCHEMA_VERSION,
  };
}

/**
 * Next value of a composition set.
 *
 * `compositionId`, `actorId`, `sessionId`, `inputFingerprint` and `looks` are
 * carried and unpatchable: selecting a look changes the SELECTION, never the
 * outfits. Rebuilding produces a new set rather than editing this one.
 */
export function reviseCompositionSet(
  previous: PrivateDressingRoomCompositionSet,
  patch: { activeLookId?: string | null },
  now?: string,
): PrivateDressingRoomCompositionSet {
  return {
    ...previous,
    activeLookId:
      'activeLookId' in patch
        ? cleanText(patch.activeLookId, PRIVATE_COMPOSITION_BOUNDS.lookId)
        : previous.activeLookId,
    updatedAt: cleanTimestamp(now) ?? new Date().toISOString(),
  };
}

/** True when this composition still describes the given session context. */
export function isCompositionCurrent(
  composition: PrivateDressingRoomCompositionSet | null | undefined,
  fingerprint: string,
): boolean {
  if (!composition) return false;
  return composition.inputFingerprint === fingerprint;
}

/** Every distinct Closet item referenced by a set, for reconciliation. */
export function collectCompositionItemIds(
  composition: PrivateDressingRoomCompositionSet | null | undefined,
): string[] {
  if (!composition) return [];
  const ids = new Set<string>();
  for (const look of composition.looks) {
    for (const item of look.items) ids.add(item.closetItemId);
  }
  return [...ids];
}

/** Slot count sanity used by tests and the composer alike. */
export const PRIVATE_SLOT_COUNT = PRIVATE_SLOTS.length;
