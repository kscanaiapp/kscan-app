/**
 * Identification-recheck telemetry (Phase 7.1 §15, §17).
 *
 * Emits ONE structured line per eligible scan, carrying enough to answer the
 * only question that matters for promotion: does the recheck produce more
 * correct fashion assertions than incorrect ones, and what did that cost?
 *
 * WHY IT LOGS EVEN WHEN NOTHING HAPPENED: a gate is only measurable against its
 * own denominator. Recording just the scans that escalated would make the gate's
 * trigger rate — the thing that decides whether this is a targeted escalation or
 * a blanket cost increase — unrecoverable from the logs.
 *
 * PRIVACY: reuses the existing `assertQualityMetricsPrivacy` walker rather than
 * shipping a second scrubber that could drift from it. The payload carries
 * garment taxonomy labels, bounded codes, counters and durations only — never an
 * image, an evidence id, a prompt, a raw provider response, or a user
 * identifier.
 */

import {
  assertQualityMetricsPrivacy,
  // @ts-ignore Deno local imports require explicit TypeScript extensions.
} from './qualityTuneTelemetry.ts';
import {
  IDENTIFICATION_RECHECK_VERSION,
  // @ts-ignore Deno local imports require explicit TypeScript extensions.
} from './identificationRecheckConfig.ts';
import type { IdentityTriple, RecheckReasonCode } from './identificationRecheckGate.ts';
import type { FieldOutcome, IdentityTier } from './identificationRecheckReconcile.ts';
import type { RecheckFailureReason } from './identificationRecheck.ts';

export type IdentificationRecheckMetrics = {
  version: string;
  flagEnabled: boolean;

  // ── Gate ───────────────────────────────────────────────────────────────────
  recheckEligible: boolean;
  /** Why an otherwise-valid scan was never a candidate. Null when eligible. */
  ineligibleReason: string | null;
  gateDecision: 'CLEAR' | 'REVIEW_REQUIRED' | 'NOT_EVALUATED';
  recheckReasonCodes: RecheckReasonCode[];
  recheckTriggered: boolean;

  // ── Identity movement ──────────────────────────────────────────────────────
  primaryIdentity: IdentityTriple;
  recheckIdentity: IdentityTriple | null;
  finalIdentity: IdentityTriple;
  identityChanged: boolean;
  fieldsChanged: IdentityTier[];
  /** Per-tier reconciliation decision, so a reversal can be attributed. */
  fieldOutcomes: Array<{ tier: IdentityTier; outcome: FieldOutcome }>;

  // ── Outcome of the second call ─────────────────────────────────────────────
  recheckStatus: 'not_run' | 'completed' | 'failed';
  recheckFailureReason: RecheckFailureReason | null;

  // ── Latency (§17) ──────────────────────────────────────────────────────────
  primaryLatencyMs: number | null;
  recheckLatencyMs: number | null;
  totalIdentificationLatencyMs: number | null;

  // ── Provider accounting (§17) ──────────────────────────────────────────────
  primaryFinishReason: string | null;
  recheckFinishReason: string | null;
  primaryInputTokens: number | null;
  primaryResponseTokens: number | null;
  primaryThinkingTokens: number | null;
  recheckInputTokens: number | null;
  recheckResponseTokens: number | null;
  recheckThinkingTokens: number | null;
  /**
   * Provider calls actually made for identification on this scan, including the
   * primary. Bounded at 2 by construction — the honest denominator for cost.
   */
  identificationProviderCalls: number;
  /** Attempts the PRIMARY call consumed, so retries are not billed to the gate. */
  primaryProviderAttempts: number | null;
};

export function logIdentificationRecheckMetrics(
  metrics: IdentificationRecheckMetrics,
): void {
  const privacy = assertQualityMetricsPrivacy(metrics);
  if (!privacy.ok) {
    console.warn(
      '[scan-identify] identification_recheck_metrics_privacy_block violations=%d',
      privacy.violations.length,
    );
    return;
  }
  console.log('[scan-identify] identification_recheck_metrics %s', JSON.stringify(metrics));
}

/** Zeroed baseline so every field is present on every emitted line. */
export function emptyRecheckMetrics(
  flagEnabled: boolean,
  primaryIdentity: IdentityTriple,
): IdentificationRecheckMetrics {
  return {
    version: IDENTIFICATION_RECHECK_VERSION,
    flagEnabled,
    recheckEligible: false,
    ineligibleReason: null,
    gateDecision: 'NOT_EVALUATED',
    recheckReasonCodes: [],
    recheckTriggered: false,
    primaryIdentity,
    recheckIdentity: null,
    finalIdentity: primaryIdentity,
    identityChanged: false,
    fieldsChanged: [],
    fieldOutcomes: [],
    recheckStatus: 'not_run',
    recheckFailureReason: null,
    primaryLatencyMs: null,
    recheckLatencyMs: null,
    totalIdentificationLatencyMs: null,
    primaryFinishReason: null,
    recheckFinishReason: null,
    primaryInputTokens: null,
    primaryResponseTokens: null,
    primaryThinkingTokens: null,
    recheckInputTokens: null,
    recheckResponseTokens: null,
    recheckThinkingTokens: null,
    identificationProviderCalls: 1,
    primaryProviderAttempts: null,
  };
}
