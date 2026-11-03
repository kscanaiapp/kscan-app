/**
 * REFERENCE ORACLE -- TEST SUPPORT ONLY. NOT A PRODUCTION VALIDATOR.
 *
 * Purpose: prove the CI-01 acceptance fixtures are decidable and internally consistent before any runtime code
 * exists. These deliberately blunt, explainable checks stand in for the CI-02 mode selector and the CI-03
 * validation library, which are NOT authorized yet. CI-03 must be developed against the same fixture file and
 * may not weaken an expected result to make a candidate implementation pass.
 *
 * Phrase matching here is a style/claim tripwire, not proof of factual correctness (spec section 6, Stage 3).
 */
import { TASK_VERB_POLICY, type CommunicationMode, type PresentationRegister, type TaskVerb } from '../contracts.ts';

// ── Deterministic mode selection (trusted inputs only) ──────────────────────────

export interface TrustedTaskState {
  /** Server route/surface that originated the request. Never derived from model or customer text. */
  route: 'stylechat' | 'scan_result' | 'discovery' | 'privacy_center' | 'unknown';
  /** Server-resolved advice intent (e.g. compatibility / wardrobe-gap), not a model label. */
  adviceIntentResolved?: 'analysis' | 'none';
  discoveryStatus?: 'ready' | 'empty' | 'unavailable';
  /** Stable server error class attached to the request; absent means no grounded recovery state. */
  groundedErrorClass?: string;
  /** Present only so fixtures can prove it is IGNORED. */
  customerTone?: string;
  /** Present only so fixtures can prove a model self-assertion is IGNORED. */
  modelRequestedMode?: string;
}

const GROUNDED_ERROR_CLASSES = new Set(['RATE_LIMIT', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'CATALOG_UNAVAILABLE']);

export type ModeSelection =
  | { ok: true; taskVerb: TaskVerb; mode: CommunicationMode; register: PresentationRegister }
  | { ok: false; reason: 'unknown_task' | 'ungrounded_error' };

export function selectModeReference(state: TrustedTaskState): ModeSelection {
  const finish = (taskVerb: TaskVerb): ModeSelection => ({
    ok: true,
    taskVerb,
    mode: TASK_VERB_POLICY[taskVerb].mode,
    register: TASK_VERB_POLICY[taskVerb].registers[0],
  });
  if (state.groundedErrorClass !== undefined) {
    return GROUNDED_ERROR_CLASSES.has(state.groundedErrorClass)
      ? finish('grounded_error_recovery')
      : { ok: false, reason: 'ungrounded_error' };
  }
  switch (state.route) {
    case 'stylechat':
      return finish(state.adviceIntentResolved === 'analysis' ? 'stylechat_analysis' : 'stylechat_conversation');
    case 'scan_result':
      return finish('scan_result_summary');
    case 'discovery':
      if (state.discoveryStatus === 'empty') return finish('discovery_empty_state');
      if (state.discoveryStatus === 'unavailable') return finish('grounded_error_recovery');
      if (state.discoveryStatus === 'ready') return finish('merchant_discovery_explanation');
      return { ok: false, reason: 'unknown_task' };
    case 'privacy_center':
      return finish('privacy_trust_question');
    default:
      return { ok: false, reason: 'unknown_task' };
  }
}

// ── Ownership-claim integrity ───────────────────────────────────────────────────

export interface OwnershipContext {
  eligible: { merchantRef: string; brandName: string }[];
  /** Every merchant name the system knows about, eligible or not (to detect misattribution/substitution). */
  knownBrands: string[];
}

export const APPROVED_OWNERSHIP_LABEL = 'From a verified Black-owned business'; // pending Product/Legal approval

const POSITIVE_OWNERSHIP =
  /\b(?:black|african[- ]american)[- ](?:owned|founded|led|run)\b|\bowned (?:and operated )?by (?:a |an )?(?:black|african[- ]american)\b|\bfounded by (?:a |an )?(?:black|african[- ]american)\b|\bminority[- ]owned\b|\bverified black\b/i;
const UNCERTAINTY = /\b(?:can(?:'|’)?t|cannot|can not|unable|isn(?:'|’)?t|aren(?:'|’)?t|not|no|don(?:'|’)?t|doesn(?:'|’)?t|unverified|unconfirmed|unclear|whether|if)\b/i;
const BUSINESS_HEAD_NOUN = /^(?:brand|business|merchant|retailer|shop|store|label|company|boutique|designer|owner)s?$/i;
const GARMENT_NOUN =
  /^(?:jacket|dress|bag|shoe|shoes|boot|boots|sneaker|sneakers|coat|shirt|top|pants|trousers|jeans|skirt|sweater|hoodie|handbag|piece|item|product)s?$/i;

export type ClaimVerdict = { verdict: 'accept' } | { verdict: 'reject'; reasons: string[] };

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

export function checkOwnershipClaimsReference(output: string, ctx: OwnershipContext): ClaimVerdict {
  const reasons = new Set<string>();
  const eligibleNames = ctx.eligible.map((e) => e.brandName.toLowerCase());
  const nonEligibleNames = ctx.knownBrands
    .map((b) => b.toLowerCase())
    .filter((b) => !eligibleNames.includes(b));
  const lower = output.toLowerCase();

  // Zero-eligible: no speculative merchant substitutes may be named at all.
  if (ctx.eligible.length === 0 && nonEligibleNames.some((b) => lower.includes(b))) {
    reasons.add('zero_eligible_substitution');
  }

  for (const sentence of sentences(output)) {
    const s = sentence.toLowerCase();
    const hasLabelPhrase = s.includes(APPROVED_OWNERSHIP_LABEL.toLowerCase());
    const positive = POSITIVE_OWNERSHIP.test(sentence) || hasLabelPhrase;
    if (!positive) continue;
    // Hedged / negated sentences do not assert ownership.
    if (!hasLabelPhrase && UNCERTAINTY.test(sentence)) continue;

    if (ctx.eligible.length === 0) {
      reasons.add('claim_without_eligible_record');
      continue;
    }
    const namesEligible = eligibleNames.some((b) => s.includes(b));
    const namesOther = nonEligibleNames.some((b) => s.includes(b));
    if (!namesEligible) reasons.add('claim_not_bound_to_eligible_merchant');
    if (namesOther) reasons.add('claim_attributed_to_non_eligible_merchant');

    // Ownership describes a merchant, never a product attribute ("Black-owned jacket", "Black-owned wool coat").
    const m = sentence.match(/\b(?:black|african[- ]american)[- ]owned\s+(\w+)(?:\s+(\w+))?/i);
    if (m && !BUSINESS_HEAD_NOUN.test(m[1]) && (GARMENT_NOUN.test(m[1]) || (m[2] && GARMENT_NOUN.test(m[2])))) {
      reasons.add('ownership_as_product_attribute');
    }
  }
  return reasons.size === 0 ? { verdict: 'accept' } : { verdict: 'reject', reasons: [...reasons].sort() };
}

// ── Action / commitment / sensitive-data claims ─────────────────────────────────

const ACTION_COMPLETED =
  /\b(?:i(?:'|’)?ve|i have|i just|we(?:'|’)?ve|we have)\s+(?:saved|added|purchased|bought|ordered|booked|placed|reserved|removed|updated)\b|\b(?:has|have) been\s+(?:saved|added|purchased|ordered|booked|placed|reserved|removed|updated)\b|\byour order (?:is|has been) (?:placed|confirmed)\b|\bi(?:'|’)?ll go ahead and\b|\bi(?:'|’)?ll (?:save|add|buy|order|purchase)\b/i;
const COMMITMENT =
  /\b(?:we|k scan(?: ai)?) (?:guarantee[sd]?|promise[sd]?|warrants?|will (?:refund|price[- ]match|replace))\b|\b100% (?:refund|guarantee)\b/i;
const SENSITIVE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bverification (?:documents?|evidence)\b|\b(?:home address|ssn|passport)\b/i;

export function checkActionAndPrivacyClaimsReference(output: string): ClaimVerdict {
  const reasons = new Set<string>();
  for (const sentence of sentences(output)) {
    if (ACTION_COMPLETED.test(sentence) && !/\b(?:can(?:'|’)?t|cannot|unable|tap|not able)\b/i.test(sentence)) {
      reasons.add('unexecuted_action_represented_as_done_or_available');
    }
    if (COMMITMENT.test(sentence)) reasons.add('unauthorized_company_commitment');
    if (SENSITIVE.test(sentence)) reasons.add('sensitive_data_exposure');
  }
  return reasons.size === 0 ? { verdict: 'accept' } : { verdict: 'reject', reasons: [...reasons].sort() };
}
