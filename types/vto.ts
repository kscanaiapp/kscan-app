/**
 * Virtual Try-On (VTO) domain contract -- provider neutral.
 *
 * Nothing in this file names a generation vendor, a credential shape, an
 * endpoint, or a provider-specific status string. Those live behind the
 * server-side provider adapter (supabase/functions/vto-generate/providers).
 * The rest of K Scan depends on THIS module, so swapping or adding a
 * generation provider is an adapter + configuration change, not an app
 * rewrite.
 *
 * VTO is VISUALIZATION. It answers "what might this look like on me", never
 * "will this fit", "what size", or anything about the person's body, health,
 * or composition -- see docs/vto-foundation.md.
 */

/** Where a try-on request came from. Deliberately not tied to one screen:
 *  the service contract must survive Elise, Dressing Rooms, Scanner, and
 *  future wearable surfaces initiating a request. */
export const VTO_ORIGINS = [
  'commerce_product',
  'closet_item',
  'scan_result',
  'dressing_room',
  'elise',
  'dev_harness',
] as const;
export type VtoOrigin = (typeof VTO_ORIGINS)[number];

/** Which part of the body the garment occupies. Derived from the garment's
 *  K Scan category by resolveVtoGarmentSlot -- never chosen by the UI. */
export type VtoGarmentSlot = 'top' | 'bottom' | 'full_body';

/**
 * Person-image provenance. Explicit user selection only -- never a profile
 * avatar, Elise avatar, Closet photo, or a previous result.
 *
 * 'live_capture' is the Live VTO clean person frame: a still the customer
 * deliberately took by tapping Photoreal inside a Live session, captured by
 * `capturePersonFrame()` and therefore free of any rendered garment. It is
 * additive -- 'photo_library' behaves exactly as before -- and it is NOT a
 * continuous or automatic source: the only producer is
 * services/vto/vtoPhotorealHandoff.ts, which refuses any frame that is not a
 * PERSON_FRAME. The composited Live preview can never appear here.
 *
 * Neither value reaches the server: services/vto/vtoClient.ts sends the image
 * bytes and nothing about where they came from.
 */
export type VtoPersonInputSource = 'photo_library' | 'live_capture';

// ─── Eligibility ──────────────────────────────────────────────────────────────

export const VTO_INELIGIBLE_REASONS = [
  'unsupported_category',
  'missing_garment_image',
  'feature_disabled',
  'entitlement_required',
  'provider_unavailable',
  'invalid_product_reference',
] as const;
export type VtoIneligibleReason = (typeof VTO_INELIGIBLE_REASONS)[number];

export type VtoEligibility =
  | { eligible: true; slot: VtoGarmentSlot }
  | { eligible: false; reason: VtoIneligibleReason };

// ─── Failures ─────────────────────────────────────────────────────────────────

/**
 * K Scan-owned failure taxonomy. A provider adapter maps its own error
 * strings/status codes INTO this set; provider text never reaches the UI.
 */
export const VTO_FAILURE_CODES = [
  'invalid_person_input',
  'invalid_garment_input',
  'unsupported_category',
  'provider_rejected_input',
  'provider_moderation',
  'provider_timeout',
  'provider_unavailable',
  /** Legacy ambiguous code retained for older deployments; copy is neutral. */
  'rate_limited',
  'quota_exhausted',
  'request_in_flight',
  'provider_busy',
  'generation_failed',
  'invalid_output',
  'authorization_failed',
  'entitlement_required',
  'feature_disabled',
  'network_failure',
  'cancelled',
  'unknown',
] as const;
export type VtoFailureCode = (typeof VTO_FAILURE_CODES)[number];

export interface VtoFailure {
  code: VtoFailureCode;
  /** User-facing copy. Never provider text. */
  message: string;
  /** Whether offering "Try again" is honest for this failure. */
  retryable: boolean;
  /** Bounded server guidance only; it never schedules an automatic retry. */
  retryAfterSeconds?: number;
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

/**
 * A person image the user explicitly chose for THIS operation, already put
 * through the metadata-stripping privacy boundary. It is a transient
 * derivative in the app cache -- it is not a saved user asset, and K Scan
 * does not persist it.
 */
export interface VtoPersonInput {
  source: VtoPersonInputSource;
  /** Local file:// URI of the sanitized derivative (cache directory). */
  sanitizedUri: string;
  width: number | null;
  height: number | null;
  /** Honest attestation from the sanitizer that produced this derivative. */
  metadataStripped: boolean;
  sanitizerVersion: string;
}

/**
 * USER-SUPPLIED GARMENT. Bounded garment media the authenticated client sends
 * inline for one explicit request, because the image exists only on this
 * device (today: a photo the customer gave Elise). The name is neutral on
 * purpose: it is NOT an ownership claim, not a Closet item, not a retailer
 * product, and it says nothing the server treats as authority.
 *
 * The content hash is a consistency signal: the server recomputes it from the
 * bytes it receives and refuses a mismatch. It proves the bytes are the bytes
 * the fingerprint names, and nothing else.
 */
export const VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE = 'user_supplied_garment' as const;

/** Mirrors CLOSET_CANDIDATE_CONTENT_HASH_VERSION and the server contract. */
export const VTO_GARMENT_CONTENT_HASH_VERSION = 'sha256-normalized-v1' as const;

/** Transport ceiling for the inline garment data URI. The same number as the
 *  server's VTO_GARMENT_PAYLOAD_MAX_CHARS; pinned equal by
 *  __tests__/vtoEliseContextualOffer.test.js. */
export const VTO_GARMENT_PAYLOAD_MAX_CHARS = 3_000_000;

export type VtoGarmentSource =
  /** Reference only. The server resolves ownership and private media. */
  | { type: 'closet_item'; closetItemId: string }
  | {
      type: typeof VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE;
      contentHash: string;
      contentHashVersion: typeof VTO_GARMENT_CONTENT_HASH_VERSION;
    };

/**
 * The garment being visualized, derived from existing K Scan commerce data.
 * VTO does not own a product catalog and must not widen one: this is a
 * reference plus the fields a generation provider actually needs.
 */
export interface VtoGarmentInput {
  source?: VtoGarmentSource;
  /** Advisory UI evidence; never sent as authority. */
  ownedMediaReady?: boolean;
  /**
   * Advisory UI evidence that a user-supplied garment's local media was found
   * when the launch was resolved. Never sent, and never authority: the bytes
   * are re-read and re-verified at generation time.
   */
  inlineMediaReady?: boolean;
  /** Stable-ish reference to the commerce candidate this came from. */
  productRef: string;
  /** Remote https image of the garment (retailer/catalog image). */
  imageUrl: string;
  /** K Scan category string as commerce produced it. */
  category: string;
  brand: string | null;
  /** Commerce provenance label, telemetry/debug only -- never a ranking input. */
  commerceSource: string | null;
}

/**
 * Reads a user-supplied garment's bytes at GENERATION time and returns them as
 * a transient data URI. Supplied by the surface that owns the device-local
 * source, so no VTO module ever touches device storage for it. The result is
 * handed straight to the transport: it is never placed in the store snapshot,
 * never persisted, and never logged. `ok: false` means the source is no longer
 * the one the launch was created for; the generation does not run.
 */
export type VtoInlineGarmentPayload = { ok: true; dataUri: string } | { ok: false };
export type VtoInlineGarmentLoader = (garment: VtoGarmentInput) => Promise<VtoInlineGarmentPayload>;

export interface VtoRequestDescriptor {
  /** Monotonic per-session token. A newer token always supersedes an older one. */
  requestId: string;
  origin: VtoOrigin;
  person: VtoPersonInput;
  garment: VtoGarmentInput;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export const VTO_STATUSES = [
  'idle',
  'selecting_input',
  'validating',
  'ready',
  'preparing',
  'generating',
  'validating_result',
  'success',
  'failed',
  'cancelled',
] as const;
export type VtoGenerationStatus = (typeof VTO_STATUSES)[number];

/** Terminal statuses. A request in one of these will never move again. */
export const VTO_TERMINAL_STATUSES: readonly VtoGenerationStatus[] = [
  'success',
  'failed',
  'cancelled',
];

// ─── Result ───────────────────────────────────────────────────────────────────

export interface VtoGenerationResult {
  requestId: string;
  /** Opaque provider identifier for telemetry. Not a credential or endpoint. */
  provider: string;
  /** data: URI. Ephemeral -- held in memory for the session, never written to
   *  the Closet, a gallery, or any durable store by this foundation. */
  dataUri: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  /** Always true. VTO output is an AI visualization and must be labelled. */
  isAiVisualization: true;
  latencyMs: number;
}

/**
 * Ownership semantics: a try-on is EVIDENCE, never ownership. Nothing here
 * may be interpreted as "the user owns this garment", and this foundation
 * writes no Closet row, purchase record, or Signature Style signal.
 */
export const VTO_CANDIDATE_KIND = 'vto_candidate' as const;
