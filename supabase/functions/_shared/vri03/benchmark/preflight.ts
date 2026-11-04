/**
 * VRI-03 benchmark preflight — go / no-go before any billed call.
 *
 * Every blocker is a stop condition from the owner's approval scope. The
 * preflight takes plain values (no Deno.env, no network), so its decisions are
 * unit-tested; the operator passes in what it observed.
 */

import {
  costFromUsage,
  type PricingRecord,
  validatePricing,
  VRI03_DEFAULT_INPUT_TOKEN_UPPER_BOUND,
  VRI03_GEMINI_CEILING_USD,
  VRI03_MAX_OUTPUT_TOKENS,
  VRI03_PRICING,
} from './budgetGuard.ts';
import { type LedgerReadiness } from './ledgerStore.ts';
import { type ManifestGateResult } from './manifestGate.ts';
import type { RoutePlan } from '../../llmModelRouting.ts';

export type PreflightInput = {
  gate: ManifestGateResult;
  ledger: LedgerReadiness;
  /** The scanner route the run will actually use: resolveRoutePlan('scanner', operatorEnv). */
  routePlan: RoutePlan;
  pricing?: PricingRecord;
  now: Date;
  /** Gemini calls per item per arm: 2 on the two-pass flow (detection + selected item). */
  callsPerItem: number;
  /** Arms that make Gemini calls (baseline + each instruction/schema change). */
  geminiArms: string[];
  repeats: number;
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
    /** The owner confirmed this spend directly in the operator session. */
    spendConfirmedByOwnerInSession: boolean;
  };
};

export type PreflightResult = {
  go: boolean;
  blockers: string[];
  models: string[];
  plannedGeminiAttempts: number;
  worstCaseUsd: number;
  spentUsd: number;
  remainingUsd: number;
  maxAffordableRepeats: number;
  plannedProviderCalls: number;
  providerCostStatus: 'INSUFFICIENT_EVIDENCE';
};

export function preflight(input: PreflightInput): PreflightResult {
  const blockers: string[] = [];
  const { env } = input;
  const pricing = input.pricing ?? VRI03_PRICING;

  if (!input.gate.pass) blockers.push(`failure-set gate failed (${input.gate.validItemCount} valid items; ${input.gate.issues.length} issue(s))`);
  for (const b of input.ledger.blockers) blockers.push(`ledger: ${b}`);

  const models = [input.routePlan.primaryModel, ...(input.routePlan.fallbackModel ? [input.routePlan.fallbackModel] : [])];
  if (input.routePlan.surface !== 'scanner') blockers.push('route plan must be the scanner surface');
  for (const issue of validatePricing({ pricing, models, now: input.now })) blockers.push(`pricing: ${issue}`);

  if (env.target !== 'staging') blockers.push('target must be "staging"');
  if (!env.targetProjectRef) blockers.push('target project ref missing');
  if (env.forbiddenProjectRefs.length === 0) blockers.push('forbidden (Production) project refs must be supplied so the run can refuse them');
  if (env.targetProjectRef && env.forbiddenProjectRefs.includes(env.targetProjectRef)) blockers.push('target project ref is a forbidden (Production) ref');
  if (!env.geminiKeyPresent) blockers.push('missing credential: Staging-scoped Gemini key');
  if (env.geminiKeyScope !== 'staging') blockers.push('Gemini key scope must be attested as "staging"');
  if (!env.testActorConsentEvidenceId.trim()) blockers.push('dedicated test actor consent evidence id missing');
  if (!env.imageRootPresent) blockers.push('governed image root not mounted');
  if (!env.spendConfirmedByOwnerInSession) blockers.push('spend not confirmed by the owner in the operator session');
  if (!(input.repeats >= 1) || !(input.callsPerItem >= 1)) blockers.push('invalid plan shape');

  // Planning bound: every attempt priced at the most expensive configured model,
  // the generous input bound and the output cap, with every attempt retried.
  const priced = models.map((m) => pricing.models[m]).filter(Boolean);
  const worstPerAttempt = priced.length
    ? Math.max(...priced.map((p) => costFromUsage(p, VRI03_DEFAULT_INPUT_TOKEN_UPPER_BOUND, VRI03_MAX_OUTPUT_TOKENS)))
    : Number.POSITIVE_INFINITY;
  const items = input.gate.validItemCount;
  const perRepeat = items * input.callsPerItem * input.geminiArms.length * Math.max(1, input.routePlan.maxAttempts);
  const plannedGeminiAttempts = perRepeat * input.repeats;
  const worstCaseUsd = plannedGeminiAttempts * worstPerAttempt;
  const spentUsd = input.ledger.inspection?.spentUsd ?? 0;
  const remainingUsd = Math.max(0, VRI03_GEMINI_CEILING_USD - spentUsd);
  const maxAffordableRepeats = perRepeat > 0 && Number.isFinite(worstPerAttempt) ? Math.floor(remainingUsd / (perRepeat * worstPerAttempt)) : 0;
  if (!(worstCaseUsd <= remainingUsd)) {
    blockers.push(`worst case $${worstCaseUsd.toFixed(2)} exceeds remaining $${remainingUsd.toFixed(2)} (max affordable repeats: ${maxAffordableRepeats})`);
  }

  return {
    go: blockers.length === 0,
    blockers,
    models,
    plannedGeminiAttempts,
    worstCaseUsd,
    spentUsd,
    remainingUsd,
    maxAffordableRepeats,
    plannedProviderCalls: items * input.providerQueriesPerItem * input.providerArms.length * input.repeats,
    providerCostStatus: 'INSUFFICIENT_EVIDENCE',
  };
}
