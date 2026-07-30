// Private Dressing Room ↔ Elise versioned contract (Build 3, Phase 4).
//
// GOVERNING SOURCE. supabase/functions/style-outfit-generate/
// privateDressingRoomEliseContract.ts is a MIRROR of this file, and
// __tests__/privateDressingRoomEliseContract.test.js asserts the two stay
// identical. This follows the established repository convention set by
// types/fashionReasoning.ts ↔ style-outfit-generate/reasoningContract.ts: the
// React Native bundle and the Deno function cannot share one module (different
// resolvers, different deployable trees), so they share one governing source
// and a static parity gate instead.
//
// PURE MODULE: no imports at all. No React, no React Native, no Expo, no
// AsyncStorage, no SecureStore, no navigation, no client stores, no Node
// built-ins, no Deno APIs, no filesystem. The contract test proves this by
// executing the transpiled module with a `require` shim that throws on ANY
// specifier — an import added here fails that test rather than silently
// pulling client code into a function bundle.
//
// WHAT THIS CONTRACT IS FOR. The private Dressing Room composes looks from the
// DEVICE-LOCAL Closet (kscan_closet.json). Those records are not server
// wardrobe rows, so the unversioned style-outfit-generate contract — which
// resolves its candidate pool server-side from saved_scans / inspiration_items
// — cannot express them. This adds an additive, explicitly versioned request
// format that carries an ephemeral, sanitized, request-scoped projection.
//
// WHAT ELISE MAY DO WITH IT: interpret a bounded occasion description, or
// validate a Build Around This anchor. It may not compose the look (the Phase 2
// deterministic composer does that), may not name a Closet item (only aliases
// exist on the wire), and may not issue an application command.

// ── Schema version ───────────────────────────────────────────────────────────

/**
 * The immutable Phase 4 schema identifier.
 *
 * A DISTINCT KEY, not a new value of `contractVersion`. The unversioned
 * style-outfit-generate contract dispatches on `contractVersion: '1'` plus a
 * valid `mode`; this contract dispatches on `schemaVersion`, which no existing
 * caller sends. That is what makes the Phase 4 branch additive: an existing
 * body cannot be reinterpreted as a Phase 4 request, and a Phase 4 body cannot
 * fall through into the existing path.
 *
 * Renaming this, or changing what it means, requires a NEW version string.
 */
export const PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION =
  'private-dressing-room-elise-v1';

export function isPrivateEliseSchemaVersion(value: unknown): boolean {
  return value === PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION;
}

// ── Intents ──────────────────────────────────────────────────────────────────

/**
 * The only remote intents.
 *
 * `make_more_casual` is deliberately absent: it is a fully on-device
 * deterministic recomposition over the existing occasion-group contract and
 * must never reach a provider. See services/privateDressingRoomCasualness.ts.
 */
export const PRIVATE_ELISE_INTENTS = ['interpret_occasion', 'build_around_item'] as const;
export type PrivateEliseIntent = (typeof PRIVATE_ELISE_INTENTS)[number];

export function isPrivateEliseIntent(value: unknown): value is PrivateEliseIntent {
  return typeof value === 'string' && (PRIVATE_ELISE_INTENTS as readonly string[]).includes(value);
}

// ── Response statuses ────────────────────────────────────────────────────────

export const PRIVATE_ELISE_STATUSES = [
  'success',
  'clarification_required',
  'unsupported',
  'invalid_request',
  'safe_failure',
] as const;
export type PrivateEliseStatus = (typeof PRIVATE_ELISE_STATUSES)[number];

export function isPrivateEliseStatus(value: unknown): value is PrivateEliseStatus {
  return typeof value === 'string' && (PRIVATE_ELISE_STATUSES as readonly string[]).includes(value);
}

// ── Domain vocabularies ──────────────────────────────────────────────────────
//
// MIRRORED, NOT INVENTED. Each list below already exists in production and the
// contract test asserts these copies equal their authoritative sources:
//
//   PRIVATE_ELISE_SLOTS        = types/privateDressingRoomComposition#PRIVATE_SLOTS
//   PRIVATE_ELISE_OCCASION_GROUPS
//                              = types/privateDressingRoomComposition#PRIVATE_OCCASION_GROUPS
//   PRIVATE_ELISE_DRESS_CODES  = types/fashionReasoning#OUTFIT_DRESS_CODES
//
// They are re-declared rather than imported because this module must stay
// import-free to be mirrorable into the Deno bundle.

export const PRIVATE_ELISE_SLOTS = [
  'top',
  'bottom',
  'dress',
  'outerwear',
  'footwear',
  'accessory',
] as const;
export type PrivateEliseSlot = (typeof PRIVATE_ELISE_SLOTS)[number];

export function isPrivateEliseSlot(value: unknown): value is PrivateEliseSlot {
  return typeof value === 'string' && (PRIVATE_ELISE_SLOTS as readonly string[]).includes(value);
}

export const PRIVATE_ELISE_OCCASION_GROUPS = [
  'casual',
  'smart_casual',
  'work',
  'evening',
  'travel',
  'neutral',
] as const;
export type PrivateEliseOccasionGroup = (typeof PRIVATE_ELISE_OCCASION_GROUPS)[number];

export function isPrivateEliseOccasionGroup(
  value: unknown,
): value is PrivateEliseOccasionGroup {
  return (
    typeof value === 'string' &&
    (PRIVATE_ELISE_OCCASION_GROUPS as readonly string[]).includes(value)
  );
}

export const PRIVATE_ELISE_DRESS_CODES = ['relaxed', 'smart_casual', 'dressy', 'formal'] as const;
export type PrivateEliseDressCode = (typeof PRIVATE_ELISE_DRESS_CODES)[number];

export function isPrivateEliseDressCode(value: unknown): value is PrivateEliseDressCode {
  return (
    typeof value === 'string' && (PRIVATE_ELISE_DRESS_CODES as readonly string[]).includes(value)
  );
}

/**
 * The occasion values Elise may return.
 *
 * EXACTLY THE ROUTE'S OWN CHIPS, plus 'Smart'. Every one of these is a value
 * the user could have selected manually, and every one is a token
 * services/privateDressingRoomComposer#occasionGroupFor already resolves:
 *
 *   Work → work        Dinner → evening    Weekend → casual
 *   Event → evening    Travel → travel     Smart → smart_casual
 *
 * 'Smart' has no chip but is a verified vocabulary token (the composer's own
 * OCCASION_GROUPS table sources it from free-tier/dailyStylePrompt.ts). It is
 * reachable today only through free text, exactly like an "Other…" entry.
 *
 * Elise therefore never creates a domain value: it SELECTS one. Anything else
 * it returns is rejected by the client before any state changes.
 */
export const PRIVATE_ELISE_OCCASIONS = [
  'Work',
  'Dinner',
  'Weekend',
  'Event',
  'Travel',
  'Smart',
] as const;
export type PrivateEliseOccasion = (typeof PRIVATE_ELISE_OCCASIONS)[number];

export function isPrivateEliseOccasion(value: unknown): value is PrivateEliseOccasion {
  return (
    typeof value === 'string' && (PRIVATE_ELISE_OCCASIONS as readonly string[]).includes(value)
  );
}

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Hard maxima. The implementation may use less; it may never use more.
 *
 * `candidates` matches the Phase 3 slot-editor cap
 * (types/privateDressingRoomInteraction#PRIVATE_INTERACTION_BOUNDS.maxCandidates
 * = 20) rather than introducing a second, larger number: a request may not
 * carry more of the Closet than the surface that produced it already shows.
 */
export const PRIVATE_ELISE_BOUNDS = Object.freeze({
  instruction: 200,
  requestId: 64,
  alias: 32,
  candidates: 20,
  lockedRefs: 1,
  clarification: 200,
  displayCopy: 200,
  category: 80,
  clothingType: 80,
  subtype: 80,
  color: 60,
  materialEntry: 60,
  materialCount: 8,
  occasionText: 120,
});

// ── Request-local aliases ────────────────────────────────────────────────────

/**
 * `item_<requestFragment>_<index>`.
 *
 * REQUEST-QUALIFIED ON PURPOSE. The fragment is derived from the request id and
 * from nothing else — not the Closet id, actor id, user id, session id or any
 * storage key — so an alias is meaningless outside the single request that
 * minted it, and two concurrent requests cannot produce a colliding alias that
 * one of them would resolve against the wrong map.
 *
 * Shape validation is necessary but never sufficient: resolution is by
 * membership in the request's own ephemeral map, and a syntactically perfect
 * alias that is not in that map is rejected.
 */
const ALIAS_PATTERN = /^item_[0-9a-f]{8}_([1-9]|1[0-9]|20)$/;

/** The 8-hex-character fragment an alias for `requestId` must carry. */
export function aliasFragmentForRequest(requestId: string): string {
  const hex = String(requestId ?? '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  return hex.slice(0, 8).padEnd(8, '0');
}

export function buildRequestAlias(requestId: string, index: number): string {
  return `item_${aliasFragmentForRequest(requestId)}_${index}`;
}

/** Shape check only. Callers must ALSO prove map membership. */
export function isWellFormedAlias(value: unknown): value is string {
  return typeof value === 'string' && ALIAS_PATTERN.test(value);
}

/** Shape check bound to one request's fragment. */
export function isAliasForRequest(value: unknown, requestId: string): value is string {
  if (!isWellFormedAlias(value)) return false;
  return value.startsWith(`item_${aliasFragmentForRequest(requestId)}_`);
}

// ── Sanitized candidate projection ───────────────────────────────────────────

/**
 * The ONLY garment fields that may leave the device.
 *
 * DERIVED FROM THE AUTHORITATIVE RECORD, NOTHING ELSE. Every field here exists
 * on services/closetItemProjection#ClosetItemProjection or is derived by
 * services/privateDressingRoomSlots#classifyClosetItemSlot.
 *
 * Deliberately ABSENT because the authoritative Closet record does not carry
 * them, and inventing them to improve model output is forbidden:
 *     texture, silhouette, fit, occasionCompatibility
 *
 * Deliberately ABSENT although the record does carry them, because Phase 4 does
 * not need them and minimization governs:
 *     id, title, notes, brand, size, origin, imageUri, thumbnailUri,
 *     createdAt, updatedAt, displaySummary, taxonomyUnknown, secondaryColors
 */
export type PrivateEliseCandidate = {
  ref: string;
  slot: PrivateEliseSlot;
  category?: string;
  clothingType?: string;
  subtype?: string;
  color?: string;
  material?: string[];
  isAnchor?: boolean;
  isLocked?: boolean;
};

/** Field allowlist. Asserted by test, not by habit. */
export const PRIVATE_ELISE_CANDIDATE_FIELDS = Object.freeze([
  'ref',
  'slot',
  'category',
  'clothingType',
  'subtype',
  'color',
  'material',
  'isAnchor',
  'isLocked',
]);

/**
 * Fields that must NEVER appear anywhere in a Phase 4 request body.
 *
 * Enumerated so the privacy suite can assert against a list rather than
 * against whatever the author remembered on the day.
 */
export const PRIVATE_ELISE_FORBIDDEN_REQUEST_FIELDS = Object.freeze([
  'actorId',
  'userId',
  'ownerId',
  'sessionId',
  'closetId',
  'closetItemId',
  'id',
  'email',
  'accessToken',
  'refreshToken',
  'token',
  'authorization',
  'imageUri',
  'thumbnailUri',
  'imagePath',
  'storagePath',
  'storageBucket',
  'signedUrl',
  'notes',
  'title',
  'sourceCandidateId',
  'sourceLineageId',
  'sourceLocalScanId',
  'sourceSavedScanId',
  'clientRequestId',
]);

// ── Request ──────────────────────────────────────────────────────────────────

export type PrivateEliseRequestContext = {
  occasion?: string;
  occasionGroup?: PrivateEliseOccasionGroup;
  dressCode?: PrivateEliseDressCode;
};

export type PrivateEliseRequest = {
  schemaVersion: typeof PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION;
  requestId: string;
  intent: PrivateEliseIntent;
  instruction: string;
  context?: PrivateEliseRequestContext;
  candidates?: PrivateEliseCandidate[];
  anchorRef?: string;
  lockedRefs?: string[];
};

export const PRIVATE_ELISE_REQUEST_FIELDS = Object.freeze([
  'schemaVersion',
  'requestId',
  'intent',
  'instruction',
  'context',
  'candidates',
  'anchorRef',
  'lockedRefs',
]);

export const PRIVATE_ELISE_CONTEXT_FIELDS = Object.freeze([
  'occasion',
  'occasionGroup',
  'dressCode',
]);

export type PrivateEliseRequestParse =
  | { ok: true; request: PrivateEliseRequest }
  | { ok: false; error: PrivateEliseRequestError };

export const PRIVATE_ELISE_REQUEST_ERRORS = [
  'not_an_object',
  'invalid_request_fields',
  'unsupported_schema_version',
  'invalid_request_id',
  'unsupported_intent',
  'invalid_instruction',
  'invalid_context',
  'invalid_candidates',
  'invalid_anchor_ref',
  'invalid_locked_refs',
] as const;
export type PrivateEliseRequestError = (typeof PRIVATE_ELISE_REQUEST_ERRORS)[number];

/**
 * Failure narrowing for both parse results.
 *
 * These exist because the mobile tsconfig (expo/tsconfig.base) does not enable
 * `strictNullChecks`, and without it TypeScript will not narrow a union on a
 * BOOLEAN discriminant — `if (!result.ok)` leaves `result` as the full union and
 * `result.error` is an error. A user-defined type predicate narrows either way,
 * so consumers read the failure reason without a cast.
 */
export function isEliseRequestFailure(
  result: PrivateEliseRequestParse,
): result is { ok: false; error: PrivateEliseRequestError } {
  return result.ok === false;
}

export function isEliseResponseFailure(
  result: PrivateEliseResponseParse,
): result is { ok: false; error: PrivateEliseResponseError } {
  return result.ok === false;
}

function textField(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses a Phase 4 request. Used by BOTH sides: the client validates what it is
 * about to send, the Edge Function validates what it received. One
 * implementation means the two can never disagree about what is legal.
 *
 * FAILS CLOSED on every unknown value. Nothing is coerced: an unsupported
 * intent is an error, not a default.
 */
export function parsePrivateEliseRequest(body: unknown): PrivateEliseRequestParse {
  if (!isPlainObject(body)) return { ok: false, error: 'not_an_object' };

  for (const key of Object.keys(body)) {
    if (!PRIVATE_ELISE_REQUEST_FIELDS.includes(key)) {
      return { ok: false, error: 'invalid_request_fields' };
    }
  }

  if (!isPrivateEliseSchemaVersion(body.schemaVersion)) {
    return { ok: false, error: 'unsupported_schema_version' };
  }

  const requestId = textField(body.requestId, PRIVATE_ELISE_BOUNDS.requestId);
  if (!requestId) return { ok: false, error: 'invalid_request_id' };

  if (!isPrivateEliseIntent(body.intent)) return { ok: false, error: 'unsupported_intent' };
  const intent = body.intent;

  const instruction = textField(body.instruction, PRIVATE_ELISE_BOUNDS.instruction);
  if (!instruction) return { ok: false, error: 'invalid_instruction' };

  let context: PrivateEliseRequestContext | undefined;
  if (body.context !== undefined) {
    if (!isPlainObject(body.context)) return { ok: false, error: 'invalid_context' };
    const raw = body.context;
    for (const key of Object.keys(raw)) {
      if (!PRIVATE_ELISE_CONTEXT_FIELDS.includes(key)) {
        return { ok: false, error: 'invalid_context' };
      }
    }
    const next: PrivateEliseRequestContext = {};
    if (raw.occasion !== undefined) {
      const occasion = textField(raw.occasion, PRIVATE_ELISE_BOUNDS.occasionText);
      if (!occasion) return { ok: false, error: 'invalid_context' };
      next.occasion = occasion;
    }
    if (raw.occasionGroup !== undefined) {
      if (!isPrivateEliseOccasionGroup(raw.occasionGroup)) {
        return { ok: false, error: 'invalid_context' };
      }
      next.occasionGroup = raw.occasionGroup;
    }
    if (raw.dressCode !== undefined) {
      if (!isPrivateEliseDressCode(raw.dressCode)) return { ok: false, error: 'invalid_context' };
      next.dressCode = raw.dressCode;
    }
    context = next;
  }

  // Candidates. Absent is legal — interpret_occasion needs no garment pool, and
  // sending one anyway would be an unnecessary disclosure.
  let candidates: PrivateEliseCandidate[] | undefined;
  if (body.candidates !== undefined) {
    if (!Array.isArray(body.candidates)) return { ok: false, error: 'invalid_candidates' };
    if (body.candidates.length > PRIVATE_ELISE_BOUNDS.candidates) {
      return { ok: false, error: 'invalid_candidates' };
    }
    const parsed: PrivateEliseCandidate[] = [];
    const seen = new Set<string>();
    for (const entry of body.candidates) {
      if (!isPlainObject(entry)) return { ok: false, error: 'invalid_candidates' };
      // An unexpected key is a rejection, not something to ignore: a candidate
      // carrying a field this contract does not name is a leak by definition.
      for (const key of Object.keys(entry)) {
        if (!PRIVATE_ELISE_CANDIDATE_FIELDS.includes(key)) {
          return { ok: false, error: 'invalid_candidates' };
        }
      }
      if (!isWellFormedAlias(entry.ref)) return { ok: false, error: 'invalid_candidates' };
      if (!isAliasForRequest(entry.ref, requestId)) {
        return { ok: false, error: 'invalid_candidates' };
      }
      if (seen.has(entry.ref)) return { ok: false, error: 'invalid_candidates' };
      seen.add(entry.ref);
      if (!isPrivateEliseSlot(entry.slot)) return { ok: false, error: 'invalid_candidates' };

      const candidate: PrivateEliseCandidate = { ref: entry.ref, slot: entry.slot };

      const category = entry.category === undefined ? null : textField(entry.category, PRIVATE_ELISE_BOUNDS.category);
      if (entry.category !== undefined && !category) return { ok: false, error: 'invalid_candidates' };
      if (category) candidate.category = category;

      const clothingType =
        entry.clothingType === undefined ? null : textField(entry.clothingType, PRIVATE_ELISE_BOUNDS.clothingType);
      if (entry.clothingType !== undefined && !clothingType) {
        return { ok: false, error: 'invalid_candidates' };
      }
      if (clothingType) candidate.clothingType = clothingType;

      const subtype = entry.subtype === undefined ? null : textField(entry.subtype, PRIVATE_ELISE_BOUNDS.subtype);
      if (entry.subtype !== undefined && !subtype) return { ok: false, error: 'invalid_candidates' };
      if (subtype) candidate.subtype = subtype;

      const color = entry.color === undefined ? null : textField(entry.color, PRIVATE_ELISE_BOUNDS.color);
      if (entry.color !== undefined && !color) return { ok: false, error: 'invalid_candidates' };
      if (color) candidate.color = color;

      if (entry.material !== undefined) {
        if (!Array.isArray(entry.material)) return { ok: false, error: 'invalid_candidates' };
        if (entry.material.length > PRIVATE_ELISE_BOUNDS.materialCount) {
          return { ok: false, error: 'invalid_candidates' };
        }
        const material: string[] = [];
        for (const value of entry.material) {
          const text = textField(value, PRIVATE_ELISE_BOUNDS.materialEntry);
          if (!text) return { ok: false, error: 'invalid_candidates' };
          material.push(text);
        }
        if (material.length > 0) candidate.material = material;
      }

      if (entry.isAnchor !== undefined) {
        if (typeof entry.isAnchor !== 'boolean') return { ok: false, error: 'invalid_candidates' };
        if (entry.isAnchor) candidate.isAnchor = true;
      }
      if (entry.isLocked !== undefined) {
        if (typeof entry.isLocked !== 'boolean') return { ok: false, error: 'invalid_candidates' };
        if (entry.isLocked) candidate.isLocked = true;
      }

      parsed.push(candidate);
    }
    candidates = parsed;
  }

  // Anchor. Required by build_around_item, forbidden for interpret_occasion —
  // an anchor with no composition intent has no reason to be transmitted.
  let anchorRef: string | undefined;
  if (body.anchorRef !== undefined) {
    if (!isAliasForRequest(body.anchorRef, requestId)) {
      return { ok: false, error: 'invalid_anchor_ref' };
    }
    if (candidates && !candidates.some((candidate) => candidate.ref === body.anchorRef)) {
      return { ok: false, error: 'invalid_anchor_ref' };
    }
    anchorRef = body.anchorRef as string;
  }
  if (intent === 'build_around_item' && !anchorRef) {
    return { ok: false, error: 'invalid_anchor_ref' };
  }
  if (intent === 'interpret_occasion' && anchorRef) {
    return { ok: false, error: 'invalid_anchor_ref' };
  }

  // Locked refs. Forward-compatible but bounded to the CURRENT product model:
  // the anchor is the only governed locked item in Phase 3, so the only legal
  // values are an empty list or exactly the anchor. Phase 4 does not build
  // future locked-slot behaviour.
  let lockedRefs: string[] | undefined;
  if (body.lockedRefs !== undefined) {
    if (!Array.isArray(body.lockedRefs)) return { ok: false, error: 'invalid_locked_refs' };
    if (body.lockedRefs.length > PRIVATE_ELISE_BOUNDS.lockedRefs) {
      return { ok: false, error: 'invalid_locked_refs' };
    }
    for (const value of body.lockedRefs) {
      if (!isAliasForRequest(value, requestId)) return { ok: false, error: 'invalid_locked_refs' };
      if (!anchorRef || value !== anchorRef) return { ok: false, error: 'invalid_locked_refs' };
    }
    lockedRefs = body.lockedRefs as string[];
  }

  const request: PrivateEliseRequest = {
    schemaVersion: PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
    requestId,
    intent,
    instruction,
  };
  if (context) request.context = context;
  if (candidates) request.candidates = candidates;
  if (anchorRef) request.anchorRef = anchorRef;
  if (lockedRefs) request.lockedRefs = lockedRefs;
  return { ok: true, request };
}

// ── Response ─────────────────────────────────────────────────────────────────

export type PrivateEliseResponse = {
  schemaVersion: typeof PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION;
  requestId: string;
  intent: PrivateEliseIntent;
  status: PrivateEliseStatus;
  normalizedOccasion?: PrivateEliseOccasion;
  dressCode?: PrivateEliseDressCode;
  occasionGroup?: PrivateEliseOccasionGroup;
  anchorRef?: string;
  selectedRefs?: string[];
  clarification?: string;
  displayCopy?: string;
};

export type PrivateEliseResponseParse =
  | { ok: true; response: PrivateEliseResponse }
  | { ok: false; error: PrivateEliseResponseError };

export const PRIVATE_ELISE_RESPONSE_ERRORS = [
  'not_an_object',
  'unsupported_schema_version',
  'request_id_mismatch',
  'intent_mismatch',
  'unsupported_status',
  'invalid_occasion',
  'invalid_dress_code',
  'invalid_occasion_group',
  'invalid_alias',
  'invalid_clarification',
  'invalid_display_copy',
  'missing_success_payload',
] as const;
export type PrivateEliseResponseError = (typeof PRIVATE_ELISE_RESPONSE_ERRORS)[number];

/**
 * Validates a Phase 4 response against the request that produced it.
 *
 * `authorizedRefs` is the alias set the client actually sent. Every alias in
 * the response must be a member: an alias outside that set is `invalid_alias`
 * and the whole response is rejected. There is no fallback to a raw Closet id,
 * because no raw Closet id was ever transmitted to fall back to.
 */
export function parsePrivateEliseResponse(
  body: unknown,
  expected: {
    requestId: string;
    intent: PrivateEliseIntent;
    authorizedRefs: readonly string[];
  },
): PrivateEliseResponseParse {
  if (!isPlainObject(body)) return { ok: false, error: 'not_an_object' };

  if (!isPrivateEliseSchemaVersion(body.schemaVersion)) {
    return { ok: false, error: 'unsupported_schema_version' };
  }
  if (typeof body.requestId !== 'string' || body.requestId !== expected.requestId) {
    return { ok: false, error: 'request_id_mismatch' };
  }
  if (!isPrivateEliseIntent(body.intent) || body.intent !== expected.intent) {
    return { ok: false, error: 'intent_mismatch' };
  }
  if (!isPrivateEliseStatus(body.status)) return { ok: false, error: 'unsupported_status' };
  const status = body.status;

  const authorized = new Set(expected.authorizedRefs);

  const response: PrivateEliseResponse = {
    schemaVersion: PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
    requestId: expected.requestId,
    intent: expected.intent,
    status,
  };

  if (body.normalizedOccasion !== undefined) {
    if (!isPrivateEliseOccasion(body.normalizedOccasion)) {
      return { ok: false, error: 'invalid_occasion' };
    }
    response.normalizedOccasion = body.normalizedOccasion;
  }
  if (body.dressCode !== undefined) {
    if (!isPrivateEliseDressCode(body.dressCode)) return { ok: false, error: 'invalid_dress_code' };
    response.dressCode = body.dressCode;
  }
  if (body.occasionGroup !== undefined) {
    if (!isPrivateEliseOccasionGroup(body.occasionGroup)) {
      return { ok: false, error: 'invalid_occasion_group' };
    }
    response.occasionGroup = body.occasionGroup;
  }
  if (body.anchorRef !== undefined) {
    if (typeof body.anchorRef !== 'string' || !authorized.has(body.anchorRef)) {
      return { ok: false, error: 'invalid_alias' };
    }
    response.anchorRef = body.anchorRef;
  }
  if (body.selectedRefs !== undefined) {
    if (!Array.isArray(body.selectedRefs)) return { ok: false, error: 'invalid_alias' };
    if (body.selectedRefs.length > PRIVATE_ELISE_BOUNDS.candidates) {
      return { ok: false, error: 'invalid_alias' };
    }
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const value of body.selectedRefs) {
      if (typeof value !== 'string' || !authorized.has(value)) {
        return { ok: false, error: 'invalid_alias' };
      }
      if (seen.has(value)) return { ok: false, error: 'invalid_alias' };
      seen.add(value);
      refs.push(value);
    }
    response.selectedRefs = refs;
  }
  if (body.clarification !== undefined) {
    const clarification = textField(body.clarification, PRIVATE_ELISE_BOUNDS.clarification);
    if (!clarification) return { ok: false, error: 'invalid_clarification' };
    response.clarification = clarification;
  }
  if (body.displayCopy !== undefined) {
    const displayCopy = textField(body.displayCopy, PRIVATE_ELISE_BOUNDS.displayCopy);
    if (!displayCopy) return { ok: false, error: 'invalid_display_copy' };
    response.displayCopy = displayCopy;
  }

  // A success must actually carry the thing the intent asked for. "success"
  // with nothing in it is a failure that would otherwise render as a win.
  if (status === 'success') {
    if (expected.intent === 'interpret_occasion' && !response.normalizedOccasion) {
      return { ok: false, error: 'missing_success_payload' };
    }
    if (expected.intent === 'build_around_item' && !response.anchorRef) {
      return { ok: false, error: 'missing_success_payload' };
    }
  }

  return { ok: true, response };
}
