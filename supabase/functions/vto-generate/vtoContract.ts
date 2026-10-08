/**
 * Server-side VTO contract.
 *
 * Deliberately a peer of types/vto.ts rather than an import of it: the client
 * bundle is React Native/Metro and this is Deno with `.ts` specifiers, and the
 * edge-function bundle closure (scripts/edge-function-manifest-lib.js) only
 * follows relative specifiers inside supabase/functions. The two are kept in
 * agreement by __tests__/vtoContractParity.test.js, which reads both files and
 * asserts the shared vocabularies are identical.
 */

export const VTO_ORIGINS = [
  'commerce_product',
  'closet_item',
  'scan_result',
  'dressing_room',
  'elise',
  'dev_harness',
] as const;
export type VtoOrigin = (typeof VTO_ORIGINS)[number];

export type VtoGarmentSlot = 'top' | 'bottom' | 'full_body';

export const VTO_FAILURE_CODES = [
  'invalid_person_input',
  'invalid_garment_input',
  'unsupported_category',
  'provider_rejected_input',
  'provider_moderation',
  'provider_timeout',
  'provider_unavailable',
  /** Legacy ambiguous code retained for older clients; no longer emitted. */
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

export const VTO_INELIGIBLE_REASONS = [
  'unsupported_category',
  'missing_garment_image',
  'feature_disabled',
  'entitlement_required',
  'provider_unavailable',
  'invalid_product_reference',
] as const;
export type VtoIneligibleReason = (typeof VTO_INELIGIBLE_REASONS)[number];

/** Accepted output media. An output outside this set is invalid_output, not
 *  something the client is asked to render and hope. */
export const VTO_ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type VtoMediaType = (typeof VTO_ALLOWED_MEDIA_TYPES)[number];

/** Transport ceiling for the base64 person payload, mirroring
 *  VTO_PERSON_PAYLOAD_MAX_CHARS on the client. A safety bound, not a vendor
 *  limit -- it exists so an absurd body is rejected cheaply. */
export const VTO_PERSON_PAYLOAD_MAX_CHARS = 2_000_000;

/**
 * USER-SUPPLIED GARMENT (the `user_supplied_garment` source).
 *
 * Some garments exist only on the customer's device -- today, a photo they
 * gave Elise -- so there is no URL for the server to fetch and no row for it to
 * resolve. Such a garment travels as a second, separately bounded data URI on
 * the same request, and is held only for the life of that request.
 *
 * THE NAME IS NEUTRAL ON PURPOSE. It means exactly "the authenticated client
 * is supplying bounded garment media for this explicit request". It does not
 * mean owned, purchased, saved to the Closet, a verified retailer product, or
 * anything about which screen it came from. `origin` stays what it always was
 * -- a telemetry label the client chooses -- and authorizes nothing.
 *
 * JPEG only: the one producer is the normalized JPEG the device-local
 * candidate store writes, so any other media type is not that source.
 */
export const VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE = 'user_supplied_garment' as const;
export const VTO_INLINE_GARMENT_MEDIA_TYPES = ['image/jpeg'] as const;

/** The one content-identity scheme an inline garment may be fingerprinted
 *  with, mirroring CLOSET_CANDIDATE_CONTENT_HASH_VERSION on the client: SHA-256
 *  over the canonical Base64 encoding of the normalized JPEG's bytes. */
export const VTO_GARMENT_CONTENT_HASH_VERSION = 'sha256-normalized-v1' as const;

/** Transport ceiling for the inline garment data URI, mirroring
 *  VTO_GARMENT_PAYLOAD_MAX_CHARS on the client. Like the person ceiling it is
 *  a safety bound, not a vendor limit. */
export const VTO_GARMENT_PAYLOAD_MAX_CHARS = 3_000_000;

/** Bounds on the DECODED inline garment. The upper one is what the encoded
 *  ceiling above already implies (3 bytes per 4 characters), stated as its own
 *  number so the decoded size is checked rather than assumed. */
export const VTO_INLINE_GARMENT_MIN_BYTES = 1024;
export const VTO_INLINE_GARMENT_MAX_BYTES = 2_250_000;

/** Room for everything in the request that is not image payload. */
export const VTO_REQUEST_ENVELOPE_MAX_CHARS = 8_192;

/** Whole-body ceiling for a request that carries NO inline garment. Unchanged
 *  from before the inline garment existed. */
export const VTO_REQUEST_BODY_MAX_CHARS =
  VTO_PERSON_PAYLOAD_MAX_CHARS + VTO_REQUEST_ENVELOPE_MAX_CHARS;

/** Whole-body ceiling for a `user_supplied_garment` request: the same envelope
 *  plus exactly one bounded garment payload. Derived, not chosen: one person
 *  image + one garment image + the envelope. No other source may use it. */
export const VTO_INLINE_GARMENT_REQUEST_BODY_MAX_CHARS =
  VTO_REQUEST_BODY_MAX_CHARS + VTO_GARMENT_PAYLOAD_MAX_CHARS;

/** Bounds on vendor Retry-After guidance K Scan will repeat to a caller. */
export const VTO_RETRY_AFTER_MIN_SECONDS = 1;
export const VTO_RETRY_AFTER_MAX_SECONDS = 3600;

/** Lower bound on a plausible decoded image. Anything under this is a
 *  truncated or empty result masquerading as success. */
export const VTO_RESULT_MIN_BYTES = 1024;
export const VTO_RESULT_MAX_BYTES = 8 * 1024 * 1024;

/** What the orchestrator hands a provider adapter. Contains no K Scan
 *  identity: an adapter never learns who the user is. */
export interface VtoProviderInput {
  /** data:image/...;base64,... of the sanitized person image. */
  personDataUri: string;
  /** Remote https garment image. Empty when `garmentDataUri` is supplied. */
  garmentImageUrl: string;
  /**
   * Bounded inline garment (data:image/jpeg;base64,...), already validated by
   * the orchestrator. When present it IS the garment: an adapter decodes it
   * directly and must not fetch `garmentImageUrl`. It is never given a URL of
   * its own, so it is never fetchable by anyone else. An adapter that does not
   * understand it finds an empty `garmentImageUrl` and fails closed.
   */
  garmentDataUri?: string;
  slot: VtoGarmentSlot;
  /** Canonical K Scan taxonomy token, e.g. 'top'. */
  canonicalCategory: string;
}

export interface VtoProviderMedia {
  dataUri: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  /** The provider's own billed-unit count for this generation, when it
   *  reports one (e.g. AILabTools' `usage.image_count`). Server-log only --
   *  never returned to a client. Provider-neutral by name: an adapter fills
   *  it in from whatever its vendor calls billing, so cost can be estimated
   *  later without inventing a cost model now (spec 22/28). Optional: most
   *  fixtures and a provider with no such concept simply omit it. */
  billedUnits?: number | null;
}

export type VtoProviderOutcome =
  | { ok: true; media: VtoProviderMedia }
  | {
      ok: false;
      /** Already normalized into K Scan's taxonomy by the adapter. */
      failure: VtoFailureCode;
      /** Short, non-sensitive adapter note for server logs only. Never
       *  returned to a client and never a raw provider body. */
      detail?: string;
      /**
       * VTO-QUOTA-003. Did this failure happen on the paying side of the
       * vendor boundary?
       *
       * `false` means the adapter can PROVE no generation was created -- it
       * never sent the submit, or the submit was refused by the gateway
       * (401/403/429/5xx) before any job existed. The orchestrator gives the
       * user's daily attempt back in that case, because charging someone for
       * an outage they did not cause is not a quota, it is a penalty.
       *
       * Absent or `true` means the vendor accepted or ran the job, so the
       * attempt stays counted whatever K Scan thought of the answer. ABSENT
       * DEFAULTS TO BILLABLE on purpose: an adapter that forgets to say
       * over-counts, which is the safe direction -- the alternative is a free
       * unbounded retry loop, which is what VTO-QUOTA-001 closed.
       */
      billable?: boolean;
      /** Bounded vendor guidance. No server or client code retries automatically. */
      retryAfterSeconds?: number;
    };

export interface VtoProvider {
  readonly id: string;
  generate(input: VtoProviderInput, options: { signal: AbortSignal }): Promise<VtoProviderOutcome>;
}
