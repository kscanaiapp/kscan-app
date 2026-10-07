/** Presentation evidence only. This module never reads or grants an entitlement. */
export type PremiumValueCapability = 'packing_intelligence' | 'smart_watchlist' | 'cloud_closet';
export type PremiumValueProofType =
  | 'packing_generation_and_refinement'
  | 'watch_tracking'
  | 'watch_worker_behavior'
  | 'watch_push_ios'
  | 'watch_push_android'
  | 'closet_outbound_sync'
  | 'closet_cross_device_restore';
export interface CapabilityProofRecord {
  readonly capability: PremiumValueCapability;
  readonly environment: 'staging' | 'production';
  readonly buildAuthority: string;
  readonly status: 'UNPROVEN' | 'PROVEN_SOURCE_ONLY' | 'PROVEN_RUNTIME';
  readonly provenAt: string;
  readonly expiresAt: string;
  readonly evidenceRef: string;
  readonly proofType: PremiumValueProofType;
}

export const PREMIUM_VALUE_BUILD_AUTHORITY = 'build35-premium-value-v2';
// No runtime proof has been certified yet. Evidence is added only after execution,
// independently for each environment and proof type. Empty means no claim.
export const PREMIUM_VALUE_PROOFS: readonly CapabilityProofRecord[] = Object.freeze([]);

export interface CapabilityProofContext {
  environment?: 'staging' | 'production';
  buildAuthority: string;
  nowMs: number;
  records: readonly CapabilityProofRecord[];
}

export function capabilityProofContext(): CapabilityProofContext {
  let environment: CapabilityProofContext['environment'];
  try {
    const host = new URL(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').hostname;
    if (host === 'yzqjvdfgefveprobvvyw.supabase.co') environment = 'staging';
    if (host === 'wyyuqfdxucjksghsmhry.supabase.co') environment = 'production';
  } catch { /* unknown environment fails closed */ }
  return { environment, buildAuthority: PREMIUM_VALUE_BUILD_AUTHORITY, nowMs: Date.now(), records: PREMIUM_VALUE_PROOFS };
}

export function hasRuntimeCapabilityProof(
  capability: PremiumValueCapability,
  proofType: PremiumValueProofType,
  context: CapabilityProofContext = capabilityProofContext(),
): boolean {
  if (!context.environment || !Number.isFinite(context.nowMs)) return false;
  return context.records.some(record => {
    const provenAt = Date.parse(record.provenAt);
    const expiresAt = Date.parse(record.expiresAt);
    return record.capability === capability && record.proofType === proofType
      && record.environment === context.environment && record.buildAuthority === context.buildAuthority
      && record.status === 'PROVEN_RUNTIME' && record.evidenceRef.trim().length > 0
      && Number.isFinite(provenAt) && Number.isFinite(expiresAt)
      && provenAt <= context.nowMs && context.nowMs < expiresAt && expiresAt > provenAt;
  });
}
