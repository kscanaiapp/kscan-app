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

/** Lower bound on a plausible decoded image. Anything under this is a
 *  truncated or empty result masquerading as success. */
export const VTO_RESULT_MIN_BYTES = 1024;
export const VTO_RESULT_MAX_BYTES = 8 * 1024 * 1024;

/** What the orchestrator hands a provider adapter. Contains no K Scan
 *  identity: an adapter never learns who the user is. */
export interface VtoProviderInput {
  /** data:image/...;base64,... of the sanitized person image. */
  personDataUri: string;
  /** Remote https garment image. */
  garmentImageUrl: string;
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
    };

export interface VtoProvider {
  readonly id: string;
  generate(input: VtoProviderInput, options: { signal: AbortSignal }): Promise<VtoProviderOutcome>;
}
