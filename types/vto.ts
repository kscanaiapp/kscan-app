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
  'scan_result',
  'dressing_room',
  'elise',
  'dev_harness',
] as const;
export type VtoOrigin = (typeof VTO_ORIGINS)[number];

/** Which part of the body the garment occupies. Derived from the garment's
 *  K Scan category by resolveVtoGarmentSlot -- never chosen by the UI. */
export type VtoGarmentSlot = 'top' | 'bottom' | 'full_body';

/** Person-image provenance. Alpha supports explicit user selection only --
 *  never a profile avatar, Elise avatar, Closet photo, or a previous result. */
export type VtoPersonInputSource = 'photo_library';

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
  'rate_limited',
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
 * The garment being visualized, derived from existing K Scan commerce data.
 * VTO does not own a product catalog and must not widen one: this is a
 * reference plus the fields a generation provider actually needs.
 */
export interface VtoGarmentInput {
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
