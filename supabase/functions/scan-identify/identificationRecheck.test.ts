/**
 * Phase 7.1 confidence-gated identification recheck — local architecture proof.
 *
 * Every scenario A–J from the build brief, against the REAL exported functions.
 * No network, no provider, no Supabase, no staging, no production, no holdout
 * data. The provider is an injected fixture, which is what makes the failure
 * paths (timeout, malformed output, truncation) testable at all — they cannot be
 * provoked reliably against a live model.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  evaluateIdentificationGate,
  isRecheckEligibleMode,
  type IdentityTriple,
} from './identificationRecheckGate.ts';
import {
  reconcileIdentification,
  type ReconciliationResult,
} from './identificationRecheckReconcile.ts';
import {
  buildRecheckPrompt,
  parseRecheckPayload,
  performIdentificationRecheck,
  RECHECK_RESPONSE_SCHEMA,
  type RecheckProvider,
  type RecheckProviderResult,
} from './identificationRecheck.ts';
import {
  IDENTIFICATION_RECHECK_DEFAULT_ENABLED,
  isIdentificationRecheckEnabled,
  RECHECK_MAX_PROVIDER_CALLS,
  resolveRecheckTimeoutMs,
} from './identificationRecheckConfig.ts';
import {
  emptyRecheckMetrics,
  type IdentificationRecheckMetrics,
} from './identificationRecheckTelemetry.ts';
import { assertQualityMetricsPrivacy } from './qualityTuneTelemetry.ts';
import { projectV2ToLegacy, normalizeToV2 } from '../_shared/fashionIdentificationV2.ts';

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const INDEX_SOURCE = Deno.readTextFileSync(`${ROOT}/supabase/functions/scan-identify/index.ts`);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const triple = (
  category: string | null,
  clothingType: string | null,
  subtype: string | null,
): IdentityTriple => ({ category, clothingType, subtype });

/** A confident, coherent, fully-observed first pass. */
function clearGateInput(overrides: Partial<Parameters<typeof evaluateIdentificationGate>[0]> = {}) {
  return {
    identity: triple('pants', 'jeans', 'wide_leg_jeans'),
    globalConfidence: 0.93,
    consistencyConflictCodes: [] as string[],
    qualityBand: 'high' as const,
    visualObservations: ['High-rise indigo denim with a wide straight leg.'],
    identityBearing: true,
    ...overrides,
  };
}

function fixtureProvider(result: Partial<RecheckProviderResult>): {
  provider: RecheckProvider;
  calls: () => number;
} {
  let calls = 0;
  const provider: RecheckProvider = () => {
    calls += 1;
    return Promise.resolve({
      ok: true,
      text: null,
      finishReason: 'STOP',
      usage: { inputTokens: 900, responseTokens: 40, thinkingTokens: 120, totalTokens: 1060 },
      failureKind: null,
      ...result,
    } as RecheckProviderResult);
  };
  return { provider, calls: () => calls };
}

const IMAGE_INPUT = { imageBase64: 'ZmFrZS1qcGVn', mimeType: 'image/jpeg' };

// ══ A — Clear identity ══════════════════════════════════════════════════════

Deno.test('A: a confident, coherent identity is CLEAR and never escalates', () => {
  const gate = evaluateIdentificationGate(clearGateInput());
  assertEquals(gate.decision, 'CLEAR');
  assertEquals(gate.reasonCodes, []);
  assertEquals(gate.triggeringReasonCodes, []);
});

Deno.test('A: a CLEAR scan preserves the primary identity untouched', () => {
  // Reconciliation is not even reached on a CLEAR scan, but if it were, an
  // agreeing pass must be a no-op.
  const result = reconcileIdentification({
    primary: triple('pants', 'jeans', 'wide_leg_jeans'),
    recheck: triple('pants', 'jeans', 'wide_leg_jeans'),
    primaryConfidence: 0.93,
    recheckConfidence: 0.9,
    reasonCodes: [],
  });
  assertEquals(result.final, triple('pants', 'jeans', 'wide_leg_jeans'));
  assertEquals(result.identityChanged, false);
  assertEquals(result.fieldsChanged, []);
  assert(result.fields.every((f) => f.outcome === 'agreed'));
});

Deno.test('A: terse-but-confident identities do NOT escalate (§6 conservatism)', () => {
  // Each of these is a MISSING value, not a contradictory one. None may spend a
  // provider call on its own.
  const missingClothingType = evaluateIdentificationGate(
    clearGateInput({ identity: triple('pants', null, 'wide_leg_jeans') }),
  );
  assertEquals(missingClothingType.decision, 'CLEAR');

  const missingSubtype = evaluateIdentificationGate(
    clearGateInput({ identity: triple('pants', 'jeans', null) }),
  );
  assertEquals(missingSubtype.decision, 'CLEAR');

  const bothLowerMissing = evaluateIdentificationGate(
    clearGateInput({ identity: triple('pants', null, null) }),
  );
  assertEquals(bothLowerMissing.decision, 'CLEAR');

  // An UNREPORTED confidence is not a low one.
  const noConfidence = evaluateIdentificationGate(clearGateInput({ globalConfidence: null }));
  assertEquals(noConfidence.decision, 'CLEAR');
});

Deno.test('A: brand and material speculation are corroborating, never sufficient', () => {
  const gate = evaluateIdentificationGate(
    clearGateInput({
      consistencyConflictCodes: ['unsupported_brand', 'unsupported_material'],
    }),
  );
  // Both reasons are RECORDED for telemetry...
  assertEquals(gate.reasonCodes, ['BRAND_IDENTITY_CONFLICT', 'MATERIAL_IDENTITY_CONFLICT']);
  // ...but neither spends a call: an unknown brand is not a misidentified garment.
  assertEquals(gate.decision, 'CLEAR');
  assertEquals(gate.triggeringReasonCodes, []);
});

// ══ B — Low-confidence subtype ══════════════════════════════════════════════

Deno.test('B: low confidence escalates, and a supported recheck fills the subtype', async () => {
  const gate = evaluateIdentificationGate(
    clearGateInput({
      identity: triple('pants', 'jeans', 'unknown'),
      globalConfidence: 0.41,
      qualityBand: 'moderate',
    }),
  );
  assertEquals(gate.decision, 'REVIEW_REQUIRED');
  assert(gate.reasonCodes.includes('LOW_IDENTITY_CONFIDENCE'));
  // "unknown" is an asserted non-answer, so it also reads as ambiguity.
  assert(gate.reasonCodes.includes('AMBIGUOUS_SUBTYPE'));

  const { provider, calls } = fixtureProvider({
    text: JSON.stringify({
      category: 'pants',
      clothing_type: 'jeans',
      subtype: 'wide_leg_jeans',
      confidence: 0.86,
    }),
  });

  const outcome = await performIdentificationRecheck(
    {
      primary: triple('pants', 'jeans', 'unknown'),
      primaryConfidence: 0.41,
      reasonCodes: gate.reasonCodes,
      garmentContext: null,
      ...IMAGE_INPUT,
    },
    provider,
  );
  assertEquals(calls(), 1);
  assertEquals(outcome.status, 'completed');
  if (outcome.status !== 'completed') throw new Error('unreachable');

  const reconciled = reconcileIdentification({
    primary: triple('pants', 'jeans', 'unknown'),
    recheck: outcome.identity,
    primaryConfidence: 0.41,
    recheckConfidence: outcome.confidence,
    reasonCodes: gate.reasonCodes,
  });

  assertEquals(reconciled.final, triple('pants', 'jeans', 'wide_leg_jeans'));
  assertEquals(reconciled.fieldsChanged, ['subtype']);
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'subtype')?.outcome,
    'accepted_supported_specificity',
  );
  // The corroborated upper tiers are retained, not rewritten.
  assertEquals(reconciled.fields.find((f) => f.tier === 'category')?.outcome, 'agreed');
  assertEquals(reconciled.fields.find((f) => f.tier === 'clothingType')?.outcome, 'agreed');
});

// ══ C — Contradictory identity ══════════════════════════════════════════════

Deno.test('C: an internally inconsistent hierarchy escalates', () => {
  // category says footwear, the middle tier says blazer.
  const gate = evaluateIdentificationGate(
    clearGateInput({ identity: triple('footwear', 'blazer', null) }),
  );
  assertEquals(gate.decision, 'REVIEW_REQUIRED');
  assert(gate.reasonCodes.includes('CATEGORY_TYPE_CONFLICT'));
});

Deno.test('C: an upstream-suppressed category/subtype conflict still escalates', () => {
  // scannerQualityGate already blanked the offending subtype, so the triple
  // itself looks clean. Its recorded conflict code is the only evidence left.
  const gate = evaluateIdentificationGate(
    clearGateInput({
      identity: triple('dress', null, null),
      consistencyConflictCodes: ['category_subtype_conflict'],
    }),
  );
  assertEquals(gate.decision, 'REVIEW_REQUIRED');
  assert(gate.reasonCodes.includes('TYPE_SUBTYPE_CONFLICT'));
});

Deno.test('C: the recheck resolves the conflict into a coherent final identity', () => {
  const reasonCodes = ['CATEGORY_TYPE_CONFLICT'] as const;
  const reconciled = reconcileIdentification({
    primary: triple('footwear', 'blazer', null),
    recheck: triple('footwear', 'boot', null),
    primaryConfidence: 0.5,
    recheckConfidence: 0.88,
    reasonCodes: [...reasonCodes],
  });
  assertEquals(reconciled.final.category, 'footwear');
  assertEquals(reconciled.final.clothingType, 'boot');
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'clothingType')?.outcome,
    'corrected',
  );

  // And the resolved identity is genuinely coherent, not merely different.
  const after = evaluateIdentificationGate(
    clearGateInput({ identity: reconciled.final }),
  );
  assert(!after.reasonCodes.includes('CATEGORY_TYPE_CONFLICT'));
});

Deno.test('C: hierarchy validation drops the narrower tier, never rewrites the broader', () => {
  // A recheck that supplies an incoherent narrow value must not drag the
  // category with it, and must never copy a tier to force agreement.
  const reconciled = reconcileIdentification({
    primary: triple('pants', null, null),
    recheck: triple('pants', 'boot', null),
    primaryConfidence: 0.4,
    recheckConfidence: 0.95,
    reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
  });
  assertEquals(reconciled.final.category, 'pants');
  assertEquals(reconciled.final.clothingType, null);
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'clothingType')?.outcome,
    'dropped_incoherent',
  );
});

// ══ D — Recheck disagrees without stronger evidence ═════════════════════════

Deno.test('D: an unsupported disagreement abstains rather than overwriting', () => {
  const reconciled = reconcileIdentification({
    primary: triple('top', 'blouse', null),
    recheck: triple('top', 'shirt', null),
    // Neither pass has the support to establish its answer.
    primaryConfidence: 0.52,
    recheckConfidence: 0.55,
    reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
  });
  assertEquals(reconciled.final.clothingType, null);
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'clothingType')?.outcome,
    'abstained_unresolved_conflict',
  );
  // The undisputed tier is untouched.
  assertEquals(reconciled.final.category, 'top');
});

Deno.test('D: a confident primary is not unseated by a weak contradiction', () => {
  const reconciled = reconcileIdentification({
    primary: triple('top', 'blouse', null),
    recheck: triple('top', 'shirt', null),
    primaryConfidence: 0.91,
    recheckConfidence: 0.6,
    reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
  });
  assertEquals(reconciled.final.clothingType, 'blouse');
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'clothingType')?.outcome,
    'retained_primary_supported',
  );
});

Deno.test('D: an unflagged tier is never rewritten, however confident the recheck', () => {
  // The gate escalated for an AMBIGUOUS_SUBTYPE. That does not license the
  // recheck to redefine the category it was not asked about.
  const reconciled = reconcileIdentification({
    primary: triple('pants', 'jeans', 'unknown'),
    recheck: triple('footwear', 'jeans', 'wide_leg_jeans'),
    primaryConfidence: 0.5,
    recheckConfidence: 0.99,
    reasonCodes: ['AMBIGUOUS_SUBTYPE'],
  });
  // Retained, NOT abstained: blanking an unchallenged tier would invent a
  // correct→unknown reversal out of the recheck changing the subject.
  assertEquals(reconciled.final.category, 'pants');
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'category')?.outcome,
    'retained_not_disputed',
  );
});

// ══ E — Unsupported specificity ═════════════════════════════════════════════

Deno.test('E: a speculative subtype two tiers below what is known is rejected', () => {
  const reconciled = reconcileIdentification({
    primary: triple('jacket', 'unknown', 'unknown'),
    // The recheck leaps straight to a precise variant for a garment whose
    // family was never established.
    recheck: triple('jacket', 'unknown', 'cropped_moto_biker_jacket'),
    primaryConfidence: 0.6,
    recheckConfidence: 0.4,
    reasonCodes: ['AMBIGUOUS_SUBTYPE'],
  });
  assertEquals(reconciled.final.subtype, null);
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'subtype')?.outcome,
    'rejected_unsupported_specificity',
  );
  assertEquals(reconciled.identityChanged, false);
});

Deno.test('E: high stated confidence does NOT buy a two-tier leap', () => {
  // The structural rule is not purchasable. A confidently-stated guess about a
  // level below an unestablished one is still a guess.
  const reconciled = reconcileIdentification({
    primary: triple('jacket', 'unknown', 'unknown'),
    recheck: triple('jacket', 'unknown', 'cropped_moto_biker_jacket'),
    primaryConfidence: 0.6,
    recheckConfidence: 0.99,
    reasonCodes: ['AMBIGUOUS_SUBTYPE'],
  });
  assertEquals(reconciled.final.subtype, null);
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'subtype')?.outcome,
    'rejected_unsupported_specificity',
  );
});

Deno.test('E: one supported tier of refinement IS allowed', () => {
  // The rule bounds the leap; it does not forbid progress.
  const reconciled = reconcileIdentification({
    primary: triple('jacket', 'unknown', 'unknown'),
    recheck: triple('jacket', 'moto jacket', 'unknown'),
    primaryConfidence: 0.6,
    recheckConfidence: 0.82,
    reasonCodes: ['AMBIGUOUS_SUBTYPE', 'LOW_IDENTITY_CONFIDENCE'],
  });
  assertEquals(reconciled.final.clothingType, 'moto jacket');
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'clothingType')?.outcome,
    'accepted_supported_specificity',
  );
});

Deno.test('E: new specificity is refused when the recheck contradicts a known tier', () => {
  // A pass that disagrees about what the garment broadly IS has not corroborated
  // the primary, so its extra detail describes a different item.
  const reconciled = reconcileIdentification({
    primary: triple('pants', 'jeans', null),
    recheck: triple('pants', 'chino', 'slim_chino'),
    primaryConfidence: 0.5,
    recheckConfidence: 0.9,
    reasonCodes: ['AMBIGUOUS_SUBTYPE'],
  });
  assertEquals(reconciled.final.subtype, null);
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'subtype')?.outcome,
    'rejected_unsupported_specificity',
  );
});

Deno.test('E: an unreported recheck confidence never counts as support', () => {
  const reconciled = reconcileIdentification({
    primary: triple('pants', 'jeans', null),
    recheck: triple('pants', 'jeans', 'wide_leg_jeans'),
    primaryConfidence: 0.5,
    recheckConfidence: null,
    reasonCodes: ['AMBIGUOUS_SUBTYPE'],
  });
  assertEquals(reconciled.final.subtype, null);
  assertEquals(
    reconciled.fields.find((f) => f.tier === 'subtype')?.outcome,
    'rejected_unsupported_specificity',
  );
});

// ══ F — Feature flag disabled ═══════════════════════════════════════════════

Deno.test('F: the flag defaults OFF and fails closed on junk env values', () => {
  assertEquals(IDENTIFICATION_RECHECK_DEFAULT_ENABLED, false);
  assertEquals(isIdentificationRecheckEnabled(() => undefined), false);
  assertEquals(isIdentificationRecheckEnabled(() => ''), false);
  assertEquals(isIdentificationRecheckEnabled(() => 'perhaps'), false);
  assertEquals(isIdentificationRecheckEnabled(() => 'false'), false);
  assertEquals(isIdentificationRecheckEnabled(() => 'true'), true);
  assertEquals(isIdentificationRecheckEnabled(() => 'ON'), true);
});

Deno.test('F: with the flag OFF the whole path is unreachable in index.ts', () => {
  // The gate, the provider call and the write-back all sit inside the flag
  // branch — proven structurally, since the handler is a Deno.serve closure
  // with no exported seam (the convention this suite's siblings already use).
  const flagIndex = INDEX_SOURCE.indexOf('const recheckFlagEnabled = isIdentificationRecheckEnabled()');
  assert(flagIndex > 0, 'recheck flag must be read in index.ts');

  const branchIndex = INDEX_SOURCE.indexOf('if (recheckFlagEnabled) {', flagIndex);
  assert(branchIndex > flagIndex, 'recheck work must sit behind the flag');

  const gateIndex = INDEX_SOURCE.indexOf('evaluateIdentificationGate({', flagIndex);
  const callIndex = INDEX_SOURCE.indexOf('performIdentificationRecheck(', flagIndex);
  const writeBackIndex = INDEX_SOURCE.indexOf('identification.item_type = reconciled.final.category', flagIndex);
  assert(gateIndex > branchIndex, 'gate evaluation must follow the flag branch');
  assert(callIndex > branchIndex, 'provider call must follow the flag branch');
  assert(writeBackIndex > branchIndex, 'identity write-back must follow the flag branch');

  // The write-back is additionally conditioned on an actual change, so a
  // no-op reconciliation cannot rewrite the sanitized identification.
  assert(
    INDEX_SOURCE.includes('if (reconciled.identityChanged && identification) {'),
    'write-back must be conditioned on identityChanged',
  );
});

Deno.test('F: with the flag OFF the function emits no recheck telemetry at all', () => {
  // Rollback must be inert in every observable way, log output included.
  const logIndex = INDEX_SOURCE.indexOf('logIdentificationRecheckMetrics(recheckMetrics);');
  assert(logIndex > 0, 'telemetry must be emitted somewhere');
  const preceding = INDEX_SOURCE.slice(Math.max(0, logIndex - 400), logIndex);
  assert(
    preceding.includes('if (recheckFlagEnabled) {'),
    'telemetry emission must sit behind the feature flag',
  );
});

Deno.test('F: an untriggered scan reports a primary-only cost baseline', () => {
  const metrics = emptyRecheckMetrics(false, triple('pants', 'jeans', 'wide_leg_jeans'));
  assertEquals(metrics.recheckTriggered, false);
  assertEquals(metrics.recheckStatus, 'not_run');
  assertEquals(metrics.identificationProviderCalls, 1);
  assertEquals(metrics.finalIdentity, metrics.primaryIdentity);
  assertEquals(metrics.identityChanged, false);
});

// ══ G — Recheck failure (fail open) ═════════════════════════════════════════

Deno.test('G: a timeout fails open to the primary identification', async () => {
  const { provider } = fixtureProvider({ ok: false, failureKind: 'timeout', usage: null });
  const outcome = await performIdentificationRecheck(
    {
      primary: triple('pants', 'jeans', null),
      primaryConfidence: 0.4,
      reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
      garmentContext: null,
      ...IMAGE_INPUT,
    },
    provider,
  );
  assertEquals(outcome.status, 'failed');
  if (outcome.status !== 'failed') throw new Error('unreachable');
  assertEquals(outcome.reason, 'timeout');
});

Deno.test('G: malformed output fails open and is never partially salvaged', async () => {
  for (const text of ['not json at all', '{"category": "pants"', '[]', '{"confidence":0.9}', '']) {
    const { provider } = fixtureProvider({ text });
    const outcome = await performIdentificationRecheck(
      {
        primary: triple('pants', 'jeans', null),
        primaryConfidence: 0.4,
        reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
        garmentContext: null,
        ...IMAGE_INPUT,
      },
      provider,
    );
    assertEquals(outcome.status, 'failed', `expected failure for: ${JSON.stringify(text)}`);
  }
});

Deno.test('G: a MAX_TOKENS finish is a failure, not a partial answer (Phase 6)', async () => {
  // Truncated-but-parseable output is the exact Phase 6 trap: it looks like a
  // usable answer. It must never reach reconciliation.
  const { provider } = fixtureProvider({
    finishReason: 'MAX_TOKENS',
    text: JSON.stringify({
      category: 'pants',
      clothing_type: 'jeans',
      subtype: 'wide_leg_jeans',
      confidence: 0.9,
    }),
  });
  const outcome = await performIdentificationRecheck(
    {
      primary: triple('pants', 'jeans', null),
      primaryConfidence: 0.4,
      reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
      garmentContext: null,
      ...IMAGE_INPUT,
    },
    provider,
  );
  assertEquals(outcome.status, 'failed');
  if (outcome.status !== 'failed') throw new Error('unreachable');
  assertEquals(outcome.reason, 'max_tokens_truncated');
  // The spend is still reported even though the answer was discarded.
  assertEquals(outcome.usage?.thinkingTokens, 120);
});

Deno.test('G: a provider that throws is caught, never propagated', async () => {
  const throwing: RecheckProvider = () => {
    throw new Error('socket exploded');
  };
  const outcome = await performIdentificationRecheck(
    {
      primary: triple('pants', 'jeans', null),
      primaryConfidence: 0.4,
      reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
      garmentContext: null,
      ...IMAGE_INPUT,
    },
    throwing,
  );
  assertEquals(outcome.status, 'failed');
  if (outcome.status !== 'failed') throw new Error('unreachable');
  assertEquals(outcome.reason, 'network_error');
});

Deno.test('G: index.ts keeps the primary identity on every failed outcome', () => {
  // The write-back is reachable only from the completed branch.
  const completedIndex = INDEX_SOURCE.indexOf("if (recheckOutcome.status === 'completed') {");
  const writeBackIndex = INDEX_SOURCE.indexOf('identification.item_type = reconciled.final.category');
  const failedBranch = INDEX_SOURCE.indexOf("recheckMetrics.recheckStatus = 'failed';");
  assert(completedIndex > 0 && writeBackIndex > completedIndex);
  assert(failedBranch > writeBackIndex, 'failure handling must follow, and not write identity');

  const failureTail = INDEX_SOURCE.slice(failedBranch, failedBranch + 400);
  assert(
    !failureTail.includes('identification.item_type ='),
    'the failure branch must never mutate the identification',
  );
});

Deno.test('G: exactly one provider call is permitted per scan', async () => {
  assertEquals(RECHECK_MAX_PROVIDER_CALLS, 1);
  const { provider, calls } = fixtureProvider({ ok: false, failureKind: 'http_error' });
  await performIdentificationRecheck(
    {
      primary: triple('pants', 'jeans', null),
      primaryConfidence: 0.4,
      reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
      garmentContext: null,
      ...IMAGE_INPUT,
    },
    provider,
  );
  // A failure does NOT trigger a retry: no loop, no escalation, no third opinion.
  assertEquals(calls(), 1);

  // And the wiring has no retry construct of its own.
  const block = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('const recheckProvider: RecheckProvider'),
    INDEX_SOURCE.indexOf('recheckMetrics.recheckLatencyMs = recheckOutcome.latencyMs'),
  );
  assert(!/\bwhile\s*\(/.test(block), 'recheck must contain no retry loop');
  assert(!/nextAttemptModel/.test(block), 'recheck must not escalate models');
});

// ══ H — Multi-item lineage ══════════════════════════════════════════════════

Deno.test('H: detection is never rechecked; only a resolved garment is eligible', () => {
  assertEquals(isRecheckEligibleMode('multi_item_detection'), false);
  assertEquals(isRecheckEligibleMode('text'), false);
  assertEquals(isRecheckEligibleMode('legacy_single_item'), true);
  assertEquals(isRecheckEligibleMode('selected_item'), true);
});

Deno.test('H: the recheck prompt pins the SELECTED garment, not the image', () => {
  const prompt = buildRecheckPrompt({
    primary: triple('pants', 'jeans', null),
    primaryConfidence: 0.4,
    reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
    garmentContext: {
      candidateId: 'cand-2',
      category: 'pants',
      subtype: 'jeans',
      bounds: { x: 0.1, y: 0.5, width: 0.3, height: 0.4 },
    },
  });
  assert(prompt.includes('previously selected from this image'));
  assert(prompt.includes('"x":0.1'), 'selected bounds must reach the recheck');
  assert(
    prompt.includes('Do not switch to a larger, more central, or more recognizable garment'),
    'the anti-drift instruction must be present',
  );
  // The candidate id is an internal correlation token and is not sent.
  assert(!prompt.includes('cand-2'));
});

Deno.test('H: index.ts sources the garment context from the resolved selection only', () => {
  const block = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('garmentContext: useSelectedItemProvider && selectedCandidate'),
    INDEX_SOURCE.indexOf('imageBase64,\n              mimeType: DEFAULT_MIME,'),
  );
  assert(block.length > 0, 'garment context wiring must exist');
  assert(
    block.includes('selectedCandidate.category') && block.includes('selectedCandidate.bounds'),
    'context must come from the selected candidate',
  );
  assert(
    !block.includes('detectedGarments'),
    'the recheck must never bind to the unresolved detection set',
  );
});

// ══ I — V1 legacy contract ══════════════════════════════════════════════════

Deno.test('I: the legacy projection gains no field and keeps its exact shape', () => {
  const v2 = normalizeToV2({
    requestId: 'req-1',
    outcome: 'classified',
    evidenceIds: ['evidence-0001'],
    identification: {
      item_type: 'pants',
      clothing_type: 'jeans',
      subtype: 'wide_leg_jeans',
      primary_color: 'indigo',
      confidence_score: 0.9,
    },
    attributes: {},
  });
  const legacy = projectV2ToLegacy(v2);
  assertEquals(Object.keys(legacy).sort(), [
    'brand_guess',
    'confidence_score',
    'item_type',
    'primary_color',
    'status',
    'subtype',
  ]);
  // The middle tier stays a V2-only concept.
  assert(!('clothingType' in legacy));
  assert(!('clothing_type' in legacy));
});

Deno.test('I: V1 and V2 stay two projections of ONE identity after reconciliation', () => {
  // The recheck writes back to the single sanitized identification, so the
  // legacy view cannot drift from the V2 view. Simulating that write-back:
  const reconciledIdentification = {
    item_type: 'footwear',
    clothing_type: 'boot',
    subtype: '',
    primary_color: 'black',
    confidence_score: 0.88,
  };
  const v2 = normalizeToV2({
    requestId: 'req-2',
    outcome: 'classified',
    evidenceIds: ['evidence-0002'],
    identification: reconciledIdentification,
    attributes: {},
  });
  const legacy = projectV2ToLegacy(v2);
  assertEquals(legacy.item_type, v2.item.category);
  assertEquals(legacy.subtype, v2.item.subtype);
  assertEquals(legacy.confidence_score, v2.compatibility.globalConfidence);
  // An abstained tier reaches both views as absence, not as a stale value.
  assertEquals(legacy.subtype, null);
  assertEquals(v2.item.subtype, null);
});

Deno.test('I: index.ts still strips clothing_type from the legacy passthrough', () => {
  assert(
    INDEX_SOURCE.includes('({ clothing_type: _omitted, ...rest })'),
    'the Phase 7 V1 tier isolation must survive this build',
  );
  // And the recheck writes BEFORE that isolation, so one identity feeds both.
  const recheckIndex = INDEX_SOURCE.indexOf('const recheckFlagEnabled = isIdentificationRecheckEnabled()');
  const isolationIndex = INDEX_SOURCE.indexOf('({ clothing_type: _omitted, ...rest })');
  assert(recheckIndex < isolationIndex, 'reconciliation must precede the legacy projection');
});

// ══ J — Product Match / commerce isolation ══════════════════════════════════

Deno.test('J: the gate accepts no commerce input at all', () => {
  const gateSource = Deno.readTextFileSync(
    `${ROOT}/supabase/functions/scan-identify/identificationRecheckGate.ts`,
  );
  for (const forbidden of [
    'product',
    'commerce',
    'retailer',
    'similarity',
    'closet',
    'catalog',
    'shopping',
    'merchant',
    'price',
  ]) {
    const re = new RegExp(`\\b${forbidden}`, 'i');
    const offending = gateSource
      .split('\n')
      .filter((line) => re.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    assertEquals(
      offending,
      [],
      `gate must not reference ${forbidden} in executable code`,
    );
  }
});

Deno.test('J: reconciliation accepts no commerce input at all', () => {
  const source = Deno.readTextFileSync(
    `${ROOT}/supabase/functions/scan-identify/identificationRecheckReconcile.ts`,
  );
  for (const forbidden of ['product', 'commerce', 'retailer', 'similarity', 'closet', 'catalog']) {
    const re = new RegExp(`\\b${forbidden}`, 'i');
    const offending = source
      .split('\n')
      .filter((line) => re.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    assertEquals(offending, [], `reconciliation must not reference ${forbidden}`);
  }
});

Deno.test('J: the recheck prompt requests no commerce and carries no products', () => {
  const prompt = buildRecheckPrompt({
    primary: triple('pants', 'jeans', null),
    primaryConfidence: 0.4,
    reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
    garmentContext: null,
  });
  // The only permitted mention of commerce is the instruction NOT to do it.
  assert(prompt.includes('Do not suggest products, retailers, prices, search queries or where to buy'));
  // What must be absent is commerce DATA and commerce-shaped output requests.
  for (
    const forbidden of [
      'recommendedProducts',
      'search_queries',
      'productMatch',
      'similarity',
      'closet',
      'brand_guess',
      'http',
      'price:',
    ]
  ) {
    assert(!prompt.includes(forbidden), `prompt must not carry ${forbidden}`);
  }
  // And the response schema cannot express commerce.
  assertEquals(Object.keys(RECHECK_RESPONSE_SCHEMA.properties).sort(), [
    'category',
    'clothing_type',
    'confidence',
    'subtype',
  ]);
});

Deno.test('J: identification is reconciled strictly BEFORE the commerce decision', () => {
  const writeBack = INDEX_SOURCE.indexOf('identification.item_type = reconciled.final.category');
  const commerceDecision = INDEX_SOURCE.indexOf('const commerceDecision = resolveCommerceDecision({');
  const commerceRouter = INDEX_SOURCE.indexOf('getScanCommerceResults({');
  assert(writeBack > 0 && commerceDecision > 0 && commerceRouter > 0);
  assert(writeBack < commerceDecision, 'identity must be final before commerce is decided');
  assert(writeBack < commerceRouter, 'identity must be final before any commerce call');
});

// ══ Cross-cutting: prompt discipline, parsing, telemetry ════════════════════

Deno.test('prompt: asks for no reasoning, no prose, and preserves the first pass', () => {
  const prompt = buildRecheckPrompt({
    primary: triple('pants', 'jeans', 'unknown'),
    primaryConfidence: 0.42,
    reasonCodes: ['LOW_IDENTITY_CONFIDENCE', 'AMBIGUOUS_SUBTYPE'],
    garmentContext: null,
  });
  assert(prompt.includes('The first-pass result may be correct'));
  assert(prompt.includes('Do not change a field merely because a second answer is requested'));
  assert(prompt.includes('Prefer uncertainty over unsupported specificity'));
  assert(prompt.includes('No markdown. No commentary. No explanation.'));
  assert(prompt.includes('LOW_IDENTITY_CONFIDENCE, AMBIGUOUS_SUBTYPE'));
  // Independence of the three tiers is stated, so the model is not invited to
  // manufacture hierarchy.
  assert(prompt.includes('Do not derive a level from a neighbouring level'));
  // No verbose-reasoning invitation.
  for (const banned of ['step by step', 'explain your', 'reasoning', 'chain of thought']) {
    assert(!prompt.toLowerCase().includes(banned), `prompt must not request: ${banned}`);
  }
});

Deno.test('parse: tolerates fenced JSON, folds "unknown" to absence', () => {
  const fenced = parseRecheckPayload(
    '```json\n{"category":"pants","clothing_type":"unknown","subtype":"wide_leg_jeans","confidence":0.8}\n```',
  );
  assert(fenced);
  assertEquals(fenced.identity.category, 'pants');
  assertEquals(fenced.identity.clothingType, null);
  assertEquals(fenced.identity.subtype, 'wide_leg_jeans');
  assertEquals(fenced.confidence, 0.8);
});

Deno.test('parse: clamps confidence and rejects absurd labels', () => {
  const high = parseRecheckPayload('{"category":"pants","confidence":9}');
  assertEquals(high?.confidence, 1);
  const low = parseRecheckPayload('{"category":"pants","confidence":-4}');
  assertEquals(low?.confidence, 0);
  const long = parseRecheckPayload(
    `{"category":"${'x'.repeat(200)}","confidence":0.9}`,
  );
  assertEquals(long?.identity.category, null);
});

Deno.test('telemetry: the emitted payload passes the repository privacy walker', () => {
  const metrics: IdentificationRecheckMetrics = {
    ...emptyRecheckMetrics(true, triple('pants', 'jeans', 'unknown')),
    recheckEligible: true,
    gateDecision: 'REVIEW_REQUIRED',
    recheckReasonCodes: ['LOW_IDENTITY_CONFIDENCE', 'AMBIGUOUS_SUBTYPE'],
    recheckTriggered: true,
    recheckIdentity: triple('pants', 'jeans', 'wide_leg_jeans'),
    finalIdentity: triple('pants', 'jeans', 'wide_leg_jeans'),
    identityChanged: true,
    fieldsChanged: ['subtype'],
    fieldOutcomes: [{ tier: 'subtype', outcome: 'accepted_supported_specificity' }],
    recheckStatus: 'completed',
    primaryLatencyMs: 1800,
    recheckLatencyMs: 700,
    totalIdentificationLatencyMs: 2500,
    primaryFinishReason: 'STOP',
    recheckFinishReason: 'STOP',
    primaryThinkingTokens: 380,
    recheckThinkingTokens: 120,
    primaryResponseTokens: 900,
    recheckResponseTokens: 40,
    identificationProviderCalls: 2,
  };
  const privacy = assertQualityMetricsPrivacy(metrics);
  assertEquals(privacy.violations, []);
  assert(privacy.ok);
});

Deno.test('telemetry: every §15/§17 field is present on the baseline record', () => {
  const metrics = emptyRecheckMetrics(true, triple('pants', null, null));
  for (
    const key of [
      'recheckEligible',
      'recheckTriggered',
      'recheckReasonCodes',
      'primaryIdentity',
      'recheckIdentity',
      'finalIdentity',
      'identityChanged',
      'fieldsChanged',
      'primaryLatencyMs',
      'recheckLatencyMs',
      'totalIdentificationLatencyMs',
      'primaryFinishReason',
      'recheckFinishReason',
      'primaryThinkingTokens',
      'recheckThinkingTokens',
      'primaryResponseTokens',
      'recheckResponseTokens',
    ]
  ) {
    assert(key in metrics, `telemetry must carry ${key}`);
  }
});

Deno.test('config: the recheck timeout is bounded and rejects hostile values', () => {
  assertEquals(resolveRecheckTimeoutMs(() => undefined), 6_000);
  assertEquals(resolveRecheckTimeoutMs(() => '3000'), 3_000);
  // Out of bounds and junk fall back to the default rather than being honoured.
  assertEquals(resolveRecheckTimeoutMs(() => '900000'), 6_000);
  assertEquals(resolveRecheckTimeoutMs(() => '10'), 6_000);
  assertEquals(resolveRecheckTimeoutMs(() => 'soon'), 6_000);
});

Deno.test('reconciliation is deterministic: identical input, identical output', () => {
  const run = (): ReconciliationResult =>
    reconcileIdentification({
      primary: triple('pants', 'jeans', 'unknown'),
      recheck: triple('pants', 'jeans', 'wide_leg_jeans'),
      primaryConfidence: 0.42,
      recheckConfidence: 0.86,
      reasonCodes: ['LOW_IDENTITY_CONFIDENCE', 'AMBIGUOUS_SUBTYPE'],
    });
  assertEquals(JSON.stringify(run()), JSON.stringify(run()));
});
