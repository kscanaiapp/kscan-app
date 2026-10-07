import { CURRENT_IMPLEMENTATION_FINGERPRINTS } from './kplusCapabilityFingerprints.generated';

/** Presentation evidence only. This module never reads or grants an entitlement. */
export type PremiumValueCapability = 'packing_intelligence' | 'smart_watchlist' | 'cloud_closet';
export type PremiumValueProofType =
  | 'packing_generation_and_refinement'
  | 'watch_tracking'
  | 'watch_provider_entitlement_boundary'
  | 'watch_worker_behavior'
  | 'watch_push_ios'
  | 'watch_push_android'
  | 'closet_outbound_sync'
  | 'closet_cross_device_restore';
export interface CapabilityProofRecord {
  readonly capability: PremiumValueCapability;
  readonly environment: 'staging' | 'production';
  /**
   * Content identity of the governed source that earned this proof, defined by
   * scripts/premium-capability-fingerprint-lib.js. The record only authorizes a
   * claim while this equals the identity of the code that is shipping.
   */
  readonly implementationFingerprint: string;
  /** Informational: a git revision whose governed files hash to the fingerprint. */
  readonly fingerprintBasisCommit?: string;
  readonly status: 'UNPROVEN' | 'PROVEN_SOURCE_ONLY' | 'PROVEN_RUNTIME';
  readonly provenAt: string;
  readonly expiresAt: string;
  readonly evidenceRef: string;
  readonly proofType: PremiumValueProofType;
}

// Staging evidence expires in seven days. Production, worker behavior, push,
// the Watch provider-side entitlement boundary and Closet restore have no
// runtime record; none inherits another proof's evidence.
//
// watch_tracking was earned against the backend deployed BEFORE the provider-side
// K+ recheck existed, so its fingerprint is the pre-change identity. It stops
// authorizing the moment the shipping Watch source differs, and is renewed only
// by a fresh run against the deployed current source.
export const PREMIUM_VALUE_PROOFS: readonly CapabilityProofRecord[] = Object.freeze([
  Object.freeze({ capability: 'packing_intelligence', environment: 'staging',
    implementationFingerprint: '7131b1404b0cfdda12e3e26b3225a6f588aa66914a1c0e993290f1c9d0cdfcdb',
    fingerprintBasisCommit: 'a57527d1', status: 'PROVEN_RUNTIME',
    provenAt: '2026-10-07T13:24:08.530Z', expiresAt: '2026-10-14T13:24:08.530Z',
    evidenceRef: 'docs/audits/build35-premium-runtime.json#packing-generate-and-refine',
    proofType: 'packing_generation_and_refinement' }),
  Object.freeze({ capability: 'smart_watchlist', environment: 'staging',
    implementationFingerprint: '3ad59c01421c879a41180489c6cc5b57eeb9af1c41111c26bf9bbb55bef92564',
    fingerprintBasisCommit: '911ac085', status: 'PROVEN_RUNTIME',
    provenAt: '2026-10-07T13:26:10.541Z', expiresAt: '2026-10-14T13:26:10.541Z',
    evidenceRef: 'docs/audits/build35-premium-runtime.json#watch-create-read-and-price-observation',
    proofType: 'watch_tracking' }),
  Object.freeze({ capability: 'cloud_closet', environment: 'staging',
    implementationFingerprint: 'fed5873f6ada1384fccfc20dc51dcb4b2e92024ed17ee336a95b8cd13fd07abe',
    fingerprintBasisCommit: 'a57527d1', status: 'PROVEN_SOURCE_ONLY',
    provenAt: '2026-10-07T13:46:00.000Z', expiresAt: '2026-10-14T13:46:00.000Z',
    evidenceRef: 'docs/audits/build35-premium-value-report.md#cloud-closet',
    proofType: 'closet_outbound_sync' }),
]);

export interface CapabilityProofContext {
  environment?: 'staging' | 'production';
  /** Current identity of the shipping governed source, keyed by proof type. */
  implementationFingerprints: Readonly<Record<string, string | undefined>>;
  nowMs: number;
  records: readonly CapabilityProofRecord[];
}

const FINGERPRINT_SHAPE = /^[0-9a-f]{64}$/;

export function capabilityProofContext(): CapabilityProofContext {
  let environment: CapabilityProofContext['environment'];
  try {
    const host = new URL(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').hostname;
    if (host === 'yzqjvdfgefveprobvvyw.supabase.co') environment = 'staging';
    if (host === 'wyyuqfdxucjksghsmhry.supabase.co') environment = 'production';
  } catch { /* unknown environment fails closed */ }
  return {
    environment,
    implementationFingerprints: CURRENT_IMPLEMENTATION_FINGERPRINTS,
    nowMs: Date.now(),
    records: PREMIUM_VALUE_PROOFS,
  };
}

/**
 * The single rule for whether a record currently authorizes its claim. Anything
 * missing, malformed, expired, from another environment, or earned by different
 * source than the one shipping is not evidence.
 */
export function isProofRecordCurrent(record: CapabilityProofRecord, context: CapabilityProofContext): boolean {
  if (!context.environment || !Number.isFinite(context.nowMs)) return false;
  const current = context.implementationFingerprints?.[record.proofType];
  if (typeof current !== 'string' || !FINGERPRINT_SHAPE.test(current)) return false;
  const provenAt = Date.parse(record.provenAt);
  const expiresAt = Date.parse(record.expiresAt);
  return record.environment === context.environment
    && record.implementationFingerprint === current
    && record.status === 'PROVEN_RUNTIME'
    && typeof record.evidenceRef === 'string' && record.evidenceRef.trim().length > 0
    && Number.isFinite(provenAt) && Number.isFinite(expiresAt)
    && provenAt <= context.nowMs && context.nowMs < expiresAt && expiresAt > provenAt;
}

export function hasRuntimeCapabilityProof(
  capability: PremiumValueCapability,
  proofType: PremiumValueProofType,
  context: CapabilityProofContext = capabilityProofContext(),
): boolean {
  return context.records.some(record => record.capability === capability
    && record.proofType === proofType && isProofRecordCurrent(record, context));
}
