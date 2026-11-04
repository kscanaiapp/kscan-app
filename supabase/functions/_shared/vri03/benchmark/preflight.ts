/**
 * VRI-03 benchmark preflight — go / no-go before any billed call.
 *
 * Every blocker is a stop condition from the owner's approval scope. The
 * preflight takes plain values (no Deno.env, no network) so its decisions are
 * unit-tested; the operator's runner passes in what it observed.
 */

import { type BudgetGuard } from './budgetGuard.ts';
import { type ManifestGateResult } from './manifestGate.ts';

export type PreflightInput = {
  gate: ManifestGateResult;
  budget: BudgetGuard;
  model: string;
  /** Gemini calls per item per arm: 2 on the two-pass flow (detection + selected item). */
  callsPerItem: number;
  /** Arms that make Gemini calls (baseline + each instruction/schema change). */
  geminiArms: string[];
  repeats: number;
  /** Max attempts per logical call (scanner route allows one fallback attempt). */
  maxAttemptsPerCall: number;
  /** Provider queries per item per query-changing arm (bounded, counted). */
  providerQueriesPerItem: number;
  providerArms: string[];
  env: {
    target: string;
    targetProjectRef: string;
    /** Refs the run must never touch (Production). Supplied by the operator, never committed. */
    forbiddenProjectRefs: string[];
    geminiKeyPresent: boolean;
    geminiKeyScope: string;
    testActorConsentEvidenceId: string;
    imageRootPresent: boolean;
    /** The owner/user confirmed this spend directly in the operator session. */
    spendConfirmedByOwnerInSession: boolean;
  };
};

export type PreflightResult = {
  go: boolean;
  blockers: string[];
  plannedGeminiCalls: number;
  worstCaseUsd: number;
  remainingUsd: number;
  maxAffordableRepeats: number;
  plannedProviderCalls: number;
  providerCostStatus: 'INSUFFICIENT_EVIDENCE';
};

export function preflight(input: PreflightInput): PreflightResult {
  const blockers: string[] = [];
  const { env } = input;

  if (!input.gate.pass) blockers.push(`failure-set gate failed (${input.gate.validItemCount} valid items; ${input.gate.issues.length} issue(s))`);
  if (env.target !== 'staging') blockers.push('target must be "staging"');
  if (!env.targetProjectRef) blockers.push('target project ref missing');
  if (env.forbiddenProjectRefs.length === 0) blockers.push('forbidden (Production) project refs must be supplied so the run can refuse them');
  if (env.targetProjectRef && env.forbiddenProjectRefs.includes(env.targetProjectRef)) blockers.push('target project ref is a forbidden (Production) ref');
  if (!env.geminiKeyPresent) blockers.push('missing credential: Staging-scoped Gemini key');
  if (env.geminiKeyScope !== 'staging') blockers.push('Gemini key scope must be attested as "staging"');
  if (!env.testActorConsentEvidenceId.trim()) blockers.push('dedicated test actor consent evidence id missing');
  if (!env.imageRootPresent) blockers.push('governed image root not mounted');
  if (!env.spendConfirmedByOwnerInSession) blockers.push('spend not confirmed by the owner in the operator session');
  if (!(input.repeats >= 1) || !(input.callsPerItem >= 1) || !(input.maxAttemptsPerCall >= 1)) blockers.push('invalid plan shape');

  const items = input.gate.validItemCount;
  const perRepeatAttempts = items * input.callsPerItem * input.geminiArms.length * input.maxAttemptsPerCall;
  const plannedGeminiCalls = perRepeatAttempts * input.repeats;
  const worstPerAttempt = input.budget.worstCaseCallUsd(input.model);
  const worstCaseUsd = plannedGeminiCalls * worstPerAttempt;
  const remainingUsd = input.budget.remainingUsd();
  const maxAffordableRepeats = perRepeatAttempts > 0 ? Math.floor(remainingUsd / (perRepeatAttempts * worstPerAttempt)) : 0;
  if (worstCaseUsd > remainingUsd) {
    blockers.push(`worst case $${worstCaseUsd.toFixed(2)} exceeds remaining $${remainingUsd.toFixed(2)} (max affordable repeats: ${maxAffordableRepeats})`);
  }

  return {
    go: blockers.length === 0,
    blockers,
    plannedGeminiCalls,
    worstCaseUsd,
    remainingUsd,
    maxAffordableRepeats,
    plannedProviderCalls: items * input.providerQueriesPerItem * input.providerArms.length * input.repeats,
    providerCostStatus: 'INSUFFICIENT_EVIDENCE',
  };
}
