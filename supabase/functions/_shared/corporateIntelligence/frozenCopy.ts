/**
 * Corporate Intelligence v2 -- frozen deterministic copy and fallback-reason mapping (CI-03).
 *
 * STATUS: offline, imported by no Edge Function. Copy WORDING is Product/Trust/Legal-controlled and is NOT approved:
 * every string here is the Management Checkpoint 1 proposal held in `PROPOSED_FALLBACK_COPY` (contracts.ts), reused
 * byte-for-byte. This module adds no new customer-facing wording.
 *
 * Design (Addendum 01 section 8):
 *   * a CLOSED, VERSIONED key set (`FROZEN_COPY_KEYS`, `FROZEN_COPY_SET_VERSION`);
 *   * ONE provisional locale-copy map (`PROVISIONAL_COPY_MAP`); a reviewed wording substitution edits only that map,
 *     never validator logic, and bumps the version;
 *   * resolution FAILS SAFE: an unknown key, a missing locale or a malformed map resolves to the pinned generic copy
 *     from contracts.ts -- never to model text, never to an empty string, never to another generation.
 */
import {
  type CorporateTaskV1,
  type FallbackCopyKey,
  type IntegrityFailureCode,
  PROPOSED_FALLBACK_COPY,
  selectFallback,
} from './contracts.ts';

export const FROZEN_COPY_SET_VERSION = 'ci03-frozen-copy-v1-proposed' as const;

/** Closed key set. Identical to the CI-01 proposal keys; adding a key is a reviewed, versioned change. */
export const FROZEN_COPY_KEYS = Object.freeze(['zero_eligible', 'ownership_integrity_failure', 'generic_integrity_failure'] as const);
export type FrozenCopyKey = (typeof FROZEN_COPY_KEYS)[number];

/** The locale the provisional copy is written in. Other locales fall back to it until translations are approved. */
export const PROVISIONAL_COPY_LOCALE = 'en' as const;

export type CopyMap = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The single provisional locale-copy map. Values are the CI-01 proposal strings, not new wording. */
export const PROVISIONAL_COPY_MAP: CopyMap = Object.freeze({
  [PROVISIONAL_COPY_LOCALE]: Object.freeze({ ...PROPOSED_FALLBACK_COPY }),
});

/**
 * Distinct, closed reasons for a deterministic response (directive section 4D, plus two claim classes that need their
 * own operational signal). A reason is observability; the COPY is chosen separately (`copyKeyFor`), so a reason can
 * never smuggle in new wording.
 */
export const FALLBACK_REASONS = [
  'ownership_integrity_failure',
  'missing_authoritative_information',
  'invalid_response_contract',
  'provider_or_validation_failure',
  'neutral_empty_inventory',
  'action_or_commitment_claim',
  'privacy_exposure',
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** Which fallback reason an integrity failure code reports. Total over INTEGRITY_FAILURE_CODES (tested). */
export const REASON_FOR_FAILURE: Readonly<Record<IntegrityFailureCode, FallbackReason>> = Object.freeze({
  unsupported_ownership_claim: 'ownership_integrity_failure',
  fabricated_merchant_recommendation: 'ownership_integrity_failure',
  verified_fact_mismatch: 'missing_authoritative_information',
  unexecuted_action_claim: 'action_or_commitment_claim',
  unauthorized_company_commitment: 'action_or_commitment_claim',
  sensitive_data_exposure: 'privacy_exposure',
  output_contract_violation: 'invalid_response_contract',
});

/**
 * Copy for a deterministic response. Failure-driven copy is delegated to the pinned CI-01 `selectFallback` (fixtures
 * fb-01..09), so the two can never disagree. Non-failure reasons map to fixed keys.
 */
export function copyKeyFor(
  input: { reason: FallbackReason; primaryFailure?: IntegrityFailureCode },
  inventoryStatus: CorporateTaskV1['inventory']['status'],
): FrozenCopyKey {
  if (input.reason === 'neutral_empty_inventory') return 'zero_eligible';
  if (input.primaryFailure) return selectFallback(input.primaryFailure, inventoryStatus).copyKey as FrozenCopyKey;
  return 'generic_integrity_failure';
}

function isFrozenCopyKey(key: unknown): key is FrozenCopyKey {
  return typeof key === 'string' && (FROZEN_COPY_KEYS as readonly string[]).includes(key);
}

/** A map is usable only if every closed key has a non-empty single-line string in the provisional locale. */
export function validateCopyMap(map: unknown): { ok: true } | { ok: false; missing: string[] } {
  if (map === null || typeof map !== 'object') return { ok: false, missing: [...FROZEN_COPY_KEYS] };
  const base = (map as Record<string, unknown>)[PROVISIONAL_COPY_LOCALE];
  const missing = FROZEN_COPY_KEYS.filter((k) => {
    const value = base !== null && typeof base === 'object' ? (base as Record<string, unknown>)[k] : undefined;
    return typeof value !== 'string' || value.trim().length === 0 || /[\r\n]/.test(value);
  });
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export type CopyResolution = {
  key: FrozenCopyKey;
  text: string;
  locale: string;
  copySetVersion: typeof FROZEN_COPY_SET_VERSION;
  /** 'exact' when the requested key/locale resolved directly; otherwise why it degraded. */
  resolution: 'exact' | 'locale_fallback' | 'unknown_key_fallback' | 'invalid_map_fallback';
};

/**
 * Resolves copy fail-safe. `map` is injectable so tests can prove a broken or partial map degrades to pinned copy.
 * Locale matching is by primary language subtag ("en-US" -> "en").
 */
export function resolveFrozenCopy(key: unknown, locale: string, map: CopyMap = PROVISIONAL_COPY_MAP): CopyResolution {
  const pinned = (k: FrozenCopyKey, resolution: CopyResolution['resolution']): CopyResolution => ({
    key: k,
    text: PROPOSED_FALLBACK_COPY[k as FallbackCopyKey],
    locale: PROVISIONAL_COPY_LOCALE,
    copySetVersion: FROZEN_COPY_SET_VERSION,
    resolution,
  });
  if (!validateCopyMap(map).ok) return pinned(isFrozenCopyKey(key) ? key : 'generic_integrity_failure', 'invalid_map_fallback');
  if (!isFrozenCopyKey(key)) return pinned('generic_integrity_failure', 'unknown_key_fallback');
  const lang = typeof locale === 'string' ? locale.split('-')[0].toLowerCase() : '';
  const localized = (map as Record<string, Record<string, string> | undefined>)[lang]?.[key];
  if (typeof localized === 'string' && localized.trim().length > 0 && !/[\r\n]/.test(localized)) {
    return { key, text: localized, locale: lang, copySetVersion: FROZEN_COPY_SET_VERSION, resolution: 'exact' };
  }
  const base = (map as Record<string, Record<string, string>>)[PROVISIONAL_COPY_LOCALE][key];
  return { key, text: base, locale: PROVISIONAL_COPY_LOCALE, copySetVersion: FROZEN_COPY_SET_VERSION, resolution: 'locale_fallback' };
}
