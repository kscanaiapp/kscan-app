/**
 * Corporate Intelligence v2 -- production-intended OUTPUT VALIDATION library (CI-03).
 *
 * STATUS: offline, transport-independent, imported by NO Edge Function (boundaries.test.ts). Wiring is CI-04 and gated.
 * Pure: no I/O, no clock (the caller passes `now`), no randomness, no model call. Never mutates its inputs.
 *
 * WHAT IT DECIDES
 *   Given a server-assembled `CorporateTaskV1` (the ONLY source of authority), a server-side merchant-name registry, and
 *   one generation CANDIDATE (from any path: initial, provider retry, completeness retry, best effort, a future fallback
 *   model), it returns accept/reject with closed failure codes, the server-rendered labels the response may carry, and
 *   a content-minimized reason trace. It never repairs, rewrites or regenerates text.
 *
 * AUTHORITY MODEL (Addendum 01 sections 4 and 7)
 *   * Every CRITICAL decision has a structural or authoritative-data basis: verified facts re-checked for freshness at
 *     validation time, exact field comparison, merchant/product binding from the task, and server-owned label text.
 *   * Text screening (normalized, clause-scoped) only locates WHERE prose makes a claim. Whether that claim is allowed is
 *     decided by the records: a merchant-specific ownership assertion is accepted only when it binds to a merchant that
 *     is eligible *now*; anything it cannot bind fails closed. A phrase match never authorizes anything.
 *   * The verified label is never taken from the model. Labels in the result are rendered from the label fact
 *     (`fact.value`, itself an APPROVED_OWNERSHIP_LABELS member); a label the model writes must match it byte-for-byte.
 *   * Model statements about actions are never execution records. A structured action-state claim is only accepted as an
 *     exact quotation of an `application_state` fact; Option B assembles none, so in practice none are accepted.
 *
 * Documented residual limits are listed in docs/build36/corporate-intelligence-v2/CI-V2-CI03-OUTPUT-VALIDATION.md.
 */
import { rejectForbiddenModelShape } from '../aiSecurity/outputValidation.ts';
import {
  APPROVED_OWNERSHIP_LABELS,
  CORPORATE_CHARTER_VERSION,
  type CorporateTaskV1,
  type IntegrityFailureCode,
  OWNERSHIP_FACT_VERBS,
  type TaskVerb,
  validateCorporateTaskV1,
  type ValidationStage,
  type VerifiedFactRef,
} from './contracts.ts';

export const OUTPUT_CONTRACT_VERSION = 'corporate-output-v1-draft' as const;
export const OUTPUT_VALIDATOR_VERSION = 'ci03-output-validator-v1' as const;

/** Existing StyleChat ceiling for validated assistant text (unchanged). */
export const MAX_OUTPUT_CHARS = 8_000;
export const MAX_WHY_CHARS = 2_000;
export const MAX_STRUCTURED_CLAIMS = 16;

// ── Generation origins (every path that can produce a candidate) ────────────────

/**
 * Every place a candidate can come from. The SAME validator applies to all of them with the SAME task; the origin is
 * recorded in the trace and never changes a verdict (property-tested). `fallback_model` exists so a future provider
 * fallback is covered by construction -- it does not imply one is wired (finding F1).
 */
export const GENERATION_ORIGINS = [
  'primary_initial',
  'primary_provider_retry',
  'completeness_retry',
  'best_effort_after_retry',
  'best_effort_initial_after_retry_failure',
  'fallback_model',
] as const;
export type GenerationOrigin = (typeof GENERATION_ORIGINS)[number];

// ── Candidate output contract (transport-independent) ───────────────────────────

/**
 * Additive, OPTIONAL structured claims (Addendum 01 section 4, "response-schema authority"). StyleChat keeps returning
 * plain text; when a structured claim is present it is validated strictly and a single invalid claim rejects the whole
 * candidate (no partial acceptance).
 */
export type StructuredClaimV1 =
  | { type: 'ownership_label'; merchantRef: string; labelText: string }
  | { type: 'merchant_reference'; merchantRef: string; productRef?: string }
  | { type: 'commerce_fact'; kind: 'price' | 'currency' | 'availability'; merchantRef: string; productRef: string; value: string }
  | { type: 'visual_observation'; label: string; confidence: 'low' | 'medium' | 'high' }
  | { type: 'policy_reference'; policyRef: string }
  | { type: 'action_state'; factId: string; state: string };

export interface CandidateOutputV1 {
  text: string;
  whyThisWorks?: string;
  /** Provider-reported finish reason (e.g. STOP, MAX_TOKENS). A truncated candidate is never accepted. */
  finishReason?: string;
  claims?: readonly StructuredClaimV1[];
}

/**
 * Server-owned list of merchant DISPLAY NAMES the platform knows (eligible or not), used only to recognise mentions of
 * NON-eligible merchants. It never grants eligibility; eligibility comes solely from the task's verified facts.
 */
export interface MerchantNameRegistry {
  knownMerchantNames: readonly string[];
}

// ── Result types ────────────────────────────────────────────────────────────────

/** Fine-grained, closed detail codes. Each maps to exactly one IntegrityFailureCode (DETAIL_TO_FAILURE). */
export const OUTPUT_DETAIL_CODES = [
  // Stage 0 / 1
  'task_contract_rejected',
  'candidate_not_object',
  'candidate_unknown_field',
  'candidate_forbidden_shape',
  'text_not_string',
  'empty_text',
  'text_too_long',
  'text_control_characters',
  'why_invalid',
  'truncated_output',
  'claims_not_array',
  'too_many_claims',
  'claim_malformed',
  // Stage 2 -- verified-fact integrity (structured)
  'label_merchant_not_eligible',
  'label_text_altered',
  'label_on_task_without_ownership_authority',
  'merchant_reference_not_eligible',
  'merchant_attribution_transfer',
  'conflicting_merchant_references',
  'commerce_fact_unsupported',
  'commerce_fact_mismatch',
  'policy_reference_not_in_task',
  'action_state_without_record',
  'observation_presented_as_verified',
  // Stage 2 -- verified-fact integrity (prose)
  'price_claim_unsupported',
  'price_claim_mismatch',
  'availability_claim_unsupported',
  // Stage 3 -- ownership claims in prose
  'claim_without_eligible_record',
  'claim_not_bound_to_eligible_merchant',
  'claim_attributed_to_non_eligible_merchant',
  'ownership_label_altered_in_prose',
  'ownership_negated_for_merchant',
  'ownership_as_product_attribute',
  'anaphoric_claim_unbound',
  'obfuscated_ownership_claim_unbound',
  // Stage 3 -- merchant recommendations (discovery tasks)
  'zero_eligible_substitution',
  'fabricated_merchant_recommendation',
  // Stage 3 -- actions, commitments, privacy
  'unexecuted_action_claim',
  'unsupported_capability_offer',
  'unauthorized_company_commitment',
  'sensitive_data_exposure',
  'internal_reference_exposure',
] as const;
export type OutputDetailCode = (typeof OUTPUT_DETAIL_CODES)[number];

export const DETAIL_TO_FAILURE: Readonly<Record<OutputDetailCode, IntegrityFailureCode>> = Object.freeze({
  task_contract_rejected: 'output_contract_violation',
  candidate_not_object: 'output_contract_violation',
  candidate_unknown_field: 'output_contract_violation',
  candidate_forbidden_shape: 'output_contract_violation',
  text_not_string: 'output_contract_violation',
  empty_text: 'output_contract_violation',
  text_too_long: 'output_contract_violation',
  text_control_characters: 'output_contract_violation',
  why_invalid: 'output_contract_violation',
  truncated_output: 'output_contract_violation',
  claims_not_array: 'output_contract_violation',
  too_many_claims: 'output_contract_violation',
  claim_malformed: 'output_contract_violation',
  label_merchant_not_eligible: 'unsupported_ownership_claim',
  label_text_altered: 'unsupported_ownership_claim',
  label_on_task_without_ownership_authority: 'unsupported_ownership_claim',
  merchant_reference_not_eligible: 'fabricated_merchant_recommendation',
  merchant_attribution_transfer: 'unsupported_ownership_claim',
  conflicting_merchant_references: 'unsupported_ownership_claim',
  commerce_fact_unsupported: 'verified_fact_mismatch',
  commerce_fact_mismatch: 'verified_fact_mismatch',
  policy_reference_not_in_task: 'unauthorized_company_commitment',
  action_state_without_record: 'unexecuted_action_claim',
  observation_presented_as_verified: 'verified_fact_mismatch',
  price_claim_unsupported: 'verified_fact_mismatch',
  price_claim_mismatch: 'verified_fact_mismatch',
  availability_claim_unsupported: 'verified_fact_mismatch',
  claim_without_eligible_record: 'unsupported_ownership_claim',
  claim_not_bound_to_eligible_merchant: 'unsupported_ownership_claim',
  claim_attributed_to_non_eligible_merchant: 'unsupported_ownership_claim',
  ownership_label_altered_in_prose: 'unsupported_ownership_claim',
  ownership_negated_for_merchant: 'unsupported_ownership_claim',
  ownership_as_product_attribute: 'unsupported_ownership_claim',
  anaphoric_claim_unbound: 'unsupported_ownership_claim',
  obfuscated_ownership_claim_unbound: 'unsupported_ownership_claim',
  zero_eligible_substitution: 'fabricated_merchant_recommendation',
  fabricated_merchant_recommendation: 'fabricated_merchant_recommendation',
  unexecuted_action_claim: 'unexecuted_action_claim',
  unsupported_capability_offer: 'unexecuted_action_claim',
  unauthorized_company_commitment: 'unauthorized_company_commitment',
  sensitive_data_exposure: 'sensitive_data_exposure',
  internal_reference_exposure: 'sensitive_data_exposure',
});

/** Severity order used to pick the PRIMARY failure (ownership/S1 first). */
export const FAILURE_PRIORITY: readonly IntegrityFailureCode[] = Object.freeze([
  'unsupported_ownership_claim',
  'fabricated_merchant_recommendation',
  'sensitive_data_exposure',
  'unexecuted_action_claim',
  'unauthorized_company_commitment',
  'verified_fact_mismatch',
  'output_contract_violation',
]);

/** A label the SERVER may render next to the response. Text always comes from the label fact, never the model. */
export interface ServerRenderedLabel {
  merchantRef: string;
  labelFactId: string;
  sourceRecordRef: string;
  labelText: string;
}

export interface OutputValidationResult {
  verdict: 'accept' | 'reject';
  /** First stage that failed, or 'stage3_claims_and_register' when everything passed. */
  stage: ValidationStage;
  failures: readonly { code: IntegrityFailureCode; detail: OutputDetailCode }[];
  primaryFailure: IntegrityFailureCode | null;
  /** Eligible merchants the response references (structured or bound prose); labels are rendered for these only. */
  labels: readonly ServerRenderedLabel[];
  /** Whether the MODEL emitted label text, and whether every emission matched the authoritative value exactly. */
  modelLabelEmitted: boolean;
  modelLabelExactMatch: boolean | null;
  eligibleMerchantsAtValidation: number;
}

export interface ValidateOutputInput {
  task: unknown;
  candidate: unknown;
  registry: MerchantNameRegistry;
  origin: GenerationOrigin;
  now: Date;
}

// ── Authoritative view (derived ONLY from the validated task, re-checked at `now`) ──

interface EligibleMerchant {
  merchantRef: string;
  name: string;
  nameKey: string;
  labelFact: VerifiedFactRef;
}
interface ProductView {
  merchantRef: string;
  productRef: string;
  price?: { amount: number; currency: string; value: string };
  currency?: string;
  availability?: string;
}
interface AuthorityView {
  verb: TaskVerb;
  ownershipAuthority: boolean;
  eligible: Map<string, EligibleMerchant>;
  products: Map<string, ProductView>;
  policyRefs: ReadonlySet<string>;
  actionFacts: Map<string, string>;
  internalRefs: string[];
  discoveryScope: boolean;
  commerceScope: boolean;
  zeroEligibleDiscovery: boolean;
}

const MS = 1_000;
const isFresh = (f: VerifiedFactRef, nowMs: number) => {
  const observed = Date.parse(f.observedAt);
  return Number.isFinite(observed) && observed + f.ttlSeconds * MS > nowMs;
};

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({ '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' });

/** Parses a server price string ("148.00", "$148.00", "€1,234.50"). Symbol, if any, must agree with the currency fact. */
export function parsePriceValue(value: string, currency: string | undefined): { amount: number; currency: string } | null {
  const m = value.trim().match(/^([$€£¥])?\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)$/);
  if (!m || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  if (m[1] && CURRENCY_SYMBOLS[m[1]] !== currency) return null; // incoherent pair: unusable, never "corrected"
  const amount = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(amount) && amount > 0 ? { amount, currency } : null;
}

function buildAuthority(task: CorporateTaskV1, nowMs: number): AuthorityView {
  const verb = task.taskVerb;
  const fresh = task.verifiedFacts.filter((f) => isFresh(f, nowMs));
  const ownershipAuthority = (OWNERSHIP_FACT_VERBS as readonly string[]).includes(verb) && task.inventory.status === 'eligible';
  const products = new Map<string, ProductView>();
  for (const f of fresh) {
    if (f.kind !== 'product_ref' || !f.merchantRef || !f.productRef) continue;
    products.set(`${f.merchantRef}|${f.productRef}`, { merchantRef: f.merchantRef, productRef: f.productRef });
  }
  for (const f of fresh) {
    const p = f.merchantRef && f.productRef ? products.get(`${f.merchantRef}|${f.productRef}`) : undefined;
    if (!p) continue;
    if (f.kind === 'availability') p.availability = f.value;
    if (f.kind === 'currency') p.currency = f.value;
  }
  for (const f of fresh) {
    const p = f.merchantRef && f.productRef ? products.get(`${f.merchantRef}|${f.productRef}`) : undefined;
    if (!p || f.kind !== 'price') continue;
    const parsed = parsePriceValue(f.value, p.currency);
    if (parsed) p.price = { ...parsed, value: f.value };
  }
  const eligible = new Map<string, EligibleMerchant>();
  if (ownershipAuthority) {
    for (const label of fresh) {
      if (label.kind !== 'ownership_label' || !label.merchantRef) continue;
      if (!APPROVED_OWNERSHIP_LABELS.includes(label.value)) continue;
      const attribution = fresh.find((f) => f.kind === 'merchant_attribution' && f.merchantRef === label.merchantRef);
      const hasProduct = [...products.values()].some((p) => p.merchantRef === label.merchantRef);
      // Expired/stale/revoked records simply are not here: the label must be fresh NOW, with a fresh product.
      if (!attribution || !hasProduct) continue;
      const nameKey = normalizeForScreening(attribution.value).toLowerCase();
      if (nameKey.length < 2) continue;
      eligible.set(label.merchantRef, { merchantRef: label.merchantRef, name: attribution.value, nameKey, labelFact: label });
    }
  }
  const actionFacts = new Map<string, string>();
  for (const f of fresh) if (f.kind === 'action_state' && f.sourceSystem === 'application_state') actionFacts.set(f.factId, f.value);
  const internalRefs = new Set<string>([task.correlationId]);
  for (const f of task.verifiedFacts) {
    for (const ref of [f.sourceRecordRef, f.merchantRef, f.productRef]) if (typeof ref === 'string' && ref.length >= 6) internalRefs.add(ref);
  }
  const discoveryScope = verb === 'merchant_discovery_explanation' || verb === 'discovery_empty_state';
  return {
    verb,
    ownershipAuthority,
    eligible,
    products,
    policyRefs: new Set(task.policyRefs),
    actionFacts,
    internalRefs: [...internalRefs],
    discoveryScope,
    commerceScope: discoveryScope || verb === 'scan_result_summary',
    zeroEligibleDiscovery: discoveryScope && eligible.size === 0,
  };
}

// ── Normalization (screening only; byte-exact label checks use the RAW model text) ──

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'І': 'I', 'Ј': 'J', 'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P', 'Ѕ': 'S',
  'Т': 'T', 'Х': 'X', 'Ү': 'Y', 'Ԁ': 'D', 'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'һ': 'h', 'і': 'i', 'ј': 'j', 'к': 'k',
  'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'ɡ': 'g', 'ӏ': 'l', 'Ӏ': 'l',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
  'Υ': 'Y', 'Χ': 'X', 'α': 'a', 'ο': 'o', 'ν': 'v', 'κ': 'k', 'ι': 'i', 'ϲ': 'c', 'ρ': 'p', 'τ': 't', 'υ': 'u',
  'ℓ': 'l', 'ı': 'i', '‐': '-', '‑': '-', '‒': '-', '−': '-', '’': "'", '‘': "'", 'ʼ': "'", '`': "'",
});
const LEET: Readonly<Record<string, string>> = Object.freeze({ '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '|': 'l', '!': 'i' });

/** NFKC, invisible-character removal, confusable folding, in-word leetspeak folding, whitespace collapse. */
export function normalizeForScreening(text: string): string {
  const folded = [...text.normalize('NFKC').replace(INVISIBLE, '')].map((ch) => CONFUSABLES[ch] ?? ch).join('');
  // Leet folding only inside tokens that mix letters with digits/symbols and do not start like a number or price.
  const deleet = folded.replace(/[A-Za-z0-9@$|!]+/g, (tok) =>
    // Sizes, prices and quantities ("3XL", "10D", "$148", "2pc") are left alone; "0wned", "B1ack", "B|ack" are folded.
    /[A-Za-z]{2,}/.test(tok) && /[0-9@$|!]/.test(tok) && !/^\$?[0-9]+(?:[.,][0-9]+)*[A-Za-z]{0,3}$/.test(tok) &&
      !/[0-9]{2,}|[$€£¥][0-9]/.test(tok)
      ? tok.replace(/[0-9@$|!]/g, (c) => LEET[c] ?? c)
      : tok
  );
  return deleet.replace(/[ \t  - 　]+/g, ' ');
}

/** Lower-case, letters only: the "compact" view used to catch spaced/punctuated obfuscation. */
const compact = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

const CLAUSE_SPLIT =
  /\s*(?:[,;&/()\[\]—–]|\s-\s|\b(?:and|but|while|whereas|although|though|yet|plus|or|as well as|because|since|whereas)\b)\s*/i;
function splitClauses(sentence: string): string[] {
  return sentence.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
}

// ── Ownership predicate detection ───────────────────────────────────────────────

const IDENTITY =
  /\b(?:black|african(?:[- ]?american\w*)?|afro[- ]?(?:american|latin|caribbean|descend)\w*|diaspora|(?:people|persons|founders?|owners?) of colou?r|negr[oa]s?|noir(?:e|es|s)?|schwarz\w*|pret[oa]s?|minority|bipoc)\b/i;
const OWNERSHIP_TERM =
  /\b(?:owned|ownership|founded|founder|founders|co-?founded|operated|propi?edad\w*|propri?edade\w*|propietari[oa]s?|propriet[áa]ri[oa]s?|due[ñn][oa]s?|dono\w*|fundad\w*|fundador\w*|propri[ée]t[ée]\w*|appartenant|fond[ée]e?s?|besitz\w*|eigentum\w*|gegr[üu]ndet|inhaber\w*|community|heritage|entrepreneurs?)\b/i;
const COMPOUND_PREDICATE = /\b(?:black|african[- ]?american|minority|bipoc)[- ]?(?:owned|founded|led|run|operated)\b/i;
const COMPACT_PREDICATE = /(?:black|africanamerican|minority)(?:owned|founded|led|operated)/;

const hasOwnershipPredicate = (clause: string) =>
  COMPOUND_PREDICATE.test(clause) || (IDENTITY.test(clause) && OWNERSHIP_TERM.test(clause));

/** Non-assertive frames that must govern the predicate INSIDE THE SAME CLAUSE. "if", "not only", "likely" are absent on purpose. */
const EPISTEMIC =
  /\b(?:whether|can(?:'|no)?t (?:confirm|verify|say|tell|determine|know)|cannot (?:confirm|verify|say|tell|determine|know)|unable to (?:confirm|verify|say|tell|determine)|not able to (?:confirm|verify|say|tell|determine)|(?:do not|don't) know|not sure|unclear|no way to (?:confirm|verify|know))\b/i;
/** Questions that nonetheless assert ("Did you know X is Black-owned?"). */
const RHETORICAL =
  /\b(?:did you know|don't you (?:think|know)|isn't it|aren't they|you know that|fun fact)\b|,\s*(?:right|correct|yes|no|true|isn't (?:it|that so)|aren't they|don't you think|you know|eh|huh)\s*\?\s*$/i;
const NEGATED_PREDICATE =
  /(?:\bnot\b|n't\b|\bnever\b|\bno longer\b)(?:\s+\w+){0,3}\s+(?:black|african[- ]?american|minority)[- ]?(?:owned|founded|led|run|operated)\b/i;
/** Plural agreement in an asserting clause: the claim covers several subjects, each of which must be eligible. */
const PLURAL_PREDICATE = /\b(?:are|were|both|all|each|they)\b/i;
const COPULA_SPLIT = /\b(?:are|were|is|was)\b/i;
/** "No (verified) Black-owned results/matches ..." -- an honest empty result, not a merchant claim. */
const NEUTRAL_EMPTY =
  /(?:\b(?:no|none|nothing|not any|aren't any|isn't any)\b|n't (?:have|find|see|show) any\b).*\b(?:results?|matches|products|items|options|listings|pieces|picks)\b/i;
const EDUCATIONAL_SUBJECT =
  /\b(?:black|african[- ]american)[- ]owned (?:(?:fashion|clothing|apparel|style|luxury|streetwear|beauty) )?(?:businesses|brands|companies|labels|designers|boutiques|retailers|enterprises|fashion|history)\b/i;
const LISTING_FRAMING =
  /\b(?:here (?:are|is)|these (?:are|brands|businesses|labels)|those (?:are|brands)|below|above|k ?scan(?:'s)?|our (?:verified|picks|list|catalog)|i (?:found|recommend|suggest|picked|selected)|we (?:found|recommend|picked)|check(?:ing)? out|you(?:'ll| will| might| may| would) love|shop (?:at|from)|try (?:these|one of)|results?|listing|verified)\b/i;
const EXAMPLE_CUE = /\b(?:such as|like|including|e\.g\.|for example|for instance|namely|especially)\b/i;
const PRONOUN_SUBJECT =
  /^(?:also\s+|and\s+|but\s+)?(?:it|they|this (?:brand|label|business|company|designer|merchant|shop|store|maker)|that (?:brand|label|business|company|designer)|the (?:brand|label|business|company|designer|merchant|shop|store|maker)|its founders?|their founders?|the founders?)\b/i;
/** Elliptical continuation that carries a previous claim to a new subject ("So is X", "X is as well", "same for X"). */
const ELLIPTICAL_CONTINUATION =
  /(?:^|\b)(?:so (?:is|are|was|were|does|do)\b|as (?:is|are|was|were)\b|same (?:goes |applies |is true )?(?:for|with)\b|likewise\b|(?:is|are|was|were) (?:as well|too|also)\s*[.!]?$|,?\s*too\s*[.!]?$|as well\s*[.!]?$)/i;
const BUSINESS_HEAD_NOUN = /^(?:brand|business|merchant|retailer|shop|store|label|company|boutique|designer|owner|founder|maker|house|atelier)s?$/i;
const GARMENT_NOUN =
  /^(?:jacket|dress|bag|shoe|boot|sneaker|coat|shirt|top|pant|pants|trousers|jean|jeans|skirt|sweater|hoodie|handbag|piece|item|product|blazer|scarf|hat|belt|tote|clutch|suit|vest|cardigan|knit|tee|blouse|gown|loafer|heel|sandal|accessor(?:y|ies)|collection|garment|outfit|look|wool|leather|denim|cotton|silk)s?$/i;

// ── Merchant mention detection ──────────────────────────────────────────────────

const NON_NAME_WORDS =
  /^(?:black|african|american|afro|owned|founded|led|run|verified|support|shop|try|here|the|this|these|those|that|our|your|my|we|you|from|and|both|great|good|news|yes|no|sure|also|so|but|if|not|only|given|since|per|like|for|with|consider|check|look|pair|wear|style|choose|explore)$/i;
const NAME_CANDIDATE = /\b[A-Z][a-z]+(?:[ '-]+(?:[A-Z][a-z]+|[A-Z]{2,}))+\b|\b[A-Z]{2,}(?:\s+[A-Z][a-z]+)+\b/g;
function containsName(haystackLower: string, nameKey: string): boolean {
  if (!nameKey) return false;
  const esc = nameKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`).test(haystackLower);
}

interface Mentions {
  eligible: Set<string>; // merchantRefs
  known: Set<string>; // non-eligible registry names (normalized)
  unknown: Set<string>; // Title-Case candidates matching nothing known
}

function findMentions(text: string, authority: AuthorityView, knownKeys: readonly string[]): Mentions {
  const lower = text.toLowerCase();
  const eligible = new Set<string>();
  const eligibleKeys: string[] = [];
  for (const m of authority.eligible.values()) {
    if (containsName(lower, m.nameKey)) {
      eligible.add(m.merchantRef);
      eligibleKeys.push(m.nameKey);
    }
  }
  const known = new Set<string>();
  for (const k of knownKeys) {
    if (eligibleKeys.includes(k)) continue;
    if (containsName(lower, k)) known.add(k);
  }
  const unknown = new Set<string>();
  // Recognised names are blanked out first so an unknown name cannot hide inside a merged Title-Case run
  // ("Both Atelier Nine & Maison Obscura").
  let residue = text;
  for (const key of [...eligibleKeys, ...known]) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    residue = residue.replace(new RegExp(esc, 'gi'), ' | ');
  }
  for (const c of residue.match(NAME_CANDIDATE) ?? []) {
    // Sentence starters and identity words are not name material ("Support Black-owned brands" is not a merchant).
    // Safe: an asserting clause that loses its only "name" this way is unbound and still fails closed.
    if (c.split(/[ '-]+/).filter((w) => !NON_NAME_WORDS.test(w)).length < 2) continue;
    const key = c.toLowerCase();
    const isKnown = eligibleKeys.some((e) => e === key || e.includes(key) || key.includes(e)) ||
      knownKeys.some((k) => k === key || k.includes(key) || key.includes(k));
    if (!isKnown && !/^(?:k scan|from a|i)$/i.test(c)) unknown.add(key);
  }
  return { eligible, known, unknown };
}

// ── Prose checks ────────────────────────────────────────────────────────────────

type Fail = (detail: OutputDetailCode) => void;

interface OwnershipOutcome {
  boundMerchants: Set<string>;
  labelEmitted: boolean;
  labelExact: boolean;
}

function checkOwnershipProse(
  raw: string,
  authority: AuthorityView,
  knownKeys: readonly string[],
  fail: Fail,
): OwnershipOutcome {
  const outcome: OwnershipOutcome = { boundMerchants: new Set(), labelEmitted: false, labelExact: true };
  const approved = APPROVED_OWNERSHIP_LABELS;
  const sentences = splitSentences(raw);
  let previousMentions: Mentions | null = null;
  let previousAssertedOwnership = false;
  const unbound = () =>
    fail(authority.eligible.size === 0 ? 'claim_without_eligible_record' : 'claim_not_bound_to_eligible_merchant');

  for (const rawSentence of sentences) {
    // Label comparison is BYTE-EXACT on the raw model text: a homoglyph, invisible character or width variant inside the
    // label is an altered label, not a match.
    const nfkc = rawSentence;
    const sentence = normalizeForScreening(rawSentence);
    const mentions = findMentions(sentence, authority, knownKeys);
    const isQuestion = /\?\s*$/.test(sentence) && !RHETORICAL.test(sentence) && !LISTING_FRAMING.test(sentence);
    const clauses = splitClauses(sentence);
    const predicateClauses = clauses.filter(hasOwnershipPredicate);
    let assertedHere = false;

    // Label text written by the model: must be byte-identical to the approved label (case and spelling included).
    const labelLike = /\bverified\b/i.test(sentence) && hasOwnershipPredicate(sentence);
    const containsExactLabel = approved.some((l) => nfkc.includes(l));
    if (containsExactLabel || (labelLike && mentions.eligible.size > 0)) outcome.labelEmitted = true;

    if (predicateClauses.length === 0) {
      // No visible predicate. (a) spaced/punctuated obfuscation of the predicate; (b) an elliptical continuation that
      // carries the previous sentence's ownership claim to a new subject.
      const obfuscated = COMPACT_PREDICATE.test(compact(sentence));
      const elliptical = previousAssertedOwnership && clauses.some((c) => ELLIPTICAL_CONTINUATION.test(c));
      if ((obfuscated || elliptical) && !isQuestion) {
        const onlyEligible = mentions.known.size === 0 && mentions.unknown.size === 0;
        const explicitEligible = mentions.eligible.size > 0;
        if (!(onlyEligible && explicitEligible)) fail(obfuscated ? 'obfuscated_ownership_claim_unbound' : 'anaphoric_claim_unbound');
        else for (const ref of mentions.eligible) outcome.boundMerchants.add(ref);
        assertedHere = true;
      }
      previousMentions = mentions;
      previousAssertedOwnership = assertedHere;
      continue;
    }

    for (const clause of predicateClauses) {
      if (isQuestion) continue; // a neutral question asserts nothing
      if (EPISTEMIC.test(clause)) continue; // "I can't confirm whether X is Black-owned"
      assertedHere = true;

      // Ownership is a merchant property, never a product attribute ("Black-owned jacket").
      const attr = clause.match(/\b(?:black|african[- ]?american|minority)[- ]?(?:owned|founded|led|run)\s+([A-Za-z]+)(?:\s+([A-Za-z]+))?/i);
      if (attr && !BUSINESS_HEAD_NOUN.test(attr[1]) && (GARMENT_NOUN.test(attr[1]) || (attr[2] !== undefined && GARMENT_NOUN.test(attr[2])))) {
        fail('ownership_as_product_attribute');
      }

      // Any merchant other than an eligible one, anywhere in an asserting sentence, fails (prevents "X and Y are ...").
      if (mentions.known.size > 0 || mentions.unknown.size > 0) {
        fail(authority.eligible.size === 0 ? 'claim_without_eligible_record' : 'claim_attributed_to_non_eligible_merchant');
        continue;
      }
      const clauseMentions = findMentions(clause, authority, knownKeys);
      // Plural claim over coordinated subjects ("X and Y are both ..."): every subject must be an eligible merchant name.
      if (clauses.length > 1 && PLURAL_PREDICATE.test(clause.split(/(?:black|african|minority)/i)[0])) {
        const idx = clauses.indexOf(clause);
        const subjects = [...clauses.slice(0, idx).filter((c) => !hasOwnershipPredicate(c)), clause.split(COPULA_SPLIT)[0]];
        const residue = (s: string) => {
          let r = s.toLowerCase();
          for (const m of authority.eligible.values()) r = r.split(m.nameKey).join(' ');
          return r.replace(/\b(?:both|all|each|the|and|also|of|them|together)\b/g, ' ').replace(/[^a-z]/g, '');
        };
        if (subjects.some((s) => residue(s).length > 0)) {
          fail('claim_attributed_to_non_eligible_merchant');
          continue;
        }
        for (const s of subjects) for (const ref of findMentions(s, authority, knownKeys).eligible) clauseMentions.eligible.add(ref);
      }
      let bound: string[] = [...clauseMentions.eligible];
      if (bound.length === 0 && PRONOUN_SUBJECT.test(clause)) {
        // Pronoun subject: binds only to exactly one eligible merchant named earlier in this sentence or the previous one.
        const local = mentions.eligible.size === 1 ? [...mentions.eligible] : [];
        const prior = previousMentions && previousMentions.eligible.size === 1 && previousMentions.known.size === 0 &&
            previousMentions.unknown.size === 0
          ? [...previousMentions.eligible]
          : [];
        bound = local.length === 1 ? local : prior;
      }
      if (bound.length === 0) {
        if (NEUTRAL_EMPTY.test(clause)) continue;
        if (EDUCATIONAL_SUBJECT.test(clause) && !LISTING_FRAMING.test(sentence) && !EXAMPLE_CUE.test(sentence)) continue;
        unbound();
        continue;
      }
      if (NEGATED_PREDICATE.test(clause)) {
        fail('ownership_negated_for_merchant');
        continue;
      }
      if (/\bverified\b/i.test(clause) && !approved.some((l) => nfkc.includes(l))) {
        outcome.labelExact = false;
        fail('ownership_label_altered_in_prose');
        continue;
      }
      for (const ref of bound) outcome.boundMerchants.add(ref);
    }

    // Elliptical continuation inside an asserting sentence must name an eligible merchant explicitly.
    if (assertedHere) {
      for (const clause of clauses) {
        if (hasOwnershipPredicate(clause) || !ELLIPTICAL_CONTINUATION.test(clause)) continue;
        if (findMentions(clause, authority, knownKeys).eligible.size === 0) fail('anaphoric_claim_unbound');
      }
    }
    // A sentence that carries the exact label but no binding to an eligible merchant transfers the label.
    if (containsExactLabel && !isQuestion && mentions.eligible.size === 0 && !(PRONOUN_SUBJECT.test(sentence) &&
      previousMentions?.eligible.size === 1)) {
      unbound();
    }
    previousMentions = mentions;
    previousAssertedOwnership = assertedHere;
  }
  return outcome;
}

const RECOMMEND_CUE =
  /\b(?:i recommend|i suggest|recommend(?:ed)?|check(?:ing)? out|shop (?:at|from)|try|consider|look (?:at|into)|go with|grab|you(?:'ll| will| would| might| may) love|great (?:alternative|option|pick)s?|alternatives?(?: like| include)?|such as|how about|instead)\b/i;
const SUBSTITUTION_FRAMING = /\b(?:similar|alternatives?|instead|substitutes?|dupes?|look-?alikes?|comparable|like this|same vibe)\b/i;

function checkMerchantRecommendations(raw: string, authority: AuthorityView, knownKeys: readonly string[], fail: Fail) {
  if (!authority.discoveryScope) return; // StyleChat may recommend brands; only discovery presents verified matches.
  for (const rawSentence of splitSentences(raw)) {
    const sentence = normalizeForScreening(rawSentence);
    const mentions = findMentions(sentence, authority, knownKeys);
    const pureQuestion = /\?\s*$/.test(sentence) && !RECOMMEND_CUE.test(sentence);
    if (authority.zeroEligibleDiscovery) {
      if (mentions.known.size > 0 && !pureQuestion) fail('zero_eligible_substitution');
      // Lower-case or unknown names cannot be recognised reliably, so substitution framing alone fails closed here.
      if (RECOMMEND_CUE.test(sentence) && SUBSTITUTION_FRAMING.test(sentence)) fail('fabricated_merchant_recommendation');
    }
    if (RECOMMEND_CUE.test(sentence)) {
      if (mentions.known.size > 0) fail('fabricated_merchant_recommendation');
      const stripped = sentence.replace(new RegExp(RECOMMEND_CUE.source, 'gi'), ' ');
      if (findMentions(stripped, authority, knownKeys).unknown.size > 0) fail('fabricated_merchant_recommendation');
    }
  }
}

const MONEY =
  /(?:(?:\b(US|CA|A|AU|NZ|HK|MX))?([$€£¥])\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?))|(?:\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s?(USD|EUR|GBP|JPY|CAD|AUD|dollars?|euros?|pounds?)\b)/gi;
const AVAILABILITY_CLAIM =
  /\b(?:in stock|available (?:now|today|to (?:buy|order)|for purchase)|ready to ship|ships? (?:today|tomorrow|now|in \d+|within)|only \d+ left|selling fast|sold out|out of stock|back in stock|low stock|limited stock|on sale|discounted|\d+% off|price (?:drop|cut))\b/i;

function moneyCurrency(prefix: string | undefined, symbol: string | undefined, word: string | undefined): string | null {
  if (symbol) {
    if (symbol === '$') {
      const p = (prefix ?? '').toUpperCase();
      return p === '' || p === 'US' ? 'USD' : p === 'CA' ? 'CAD' : p === 'A' || p === 'AU' ? 'AUD' : p === 'NZ' ? 'NZD' : p === 'HK' ? 'HKD' : 'MXN';
    }
    return CURRENCY_SYMBOLS[symbol] ?? null;
  }
  const w = (word ?? '').toLowerCase();
  if (/^dollars?$/.test(w)) return null; // ambiguous word: amount must still match, currency is not asserted
  if (/^euros?$/.test(w)) return 'EUR';
  if (/^pounds?$/.test(w)) return 'GBP';
  return w.toUpperCase();
}

function checkCommerceProse(raw: string, authority: AuthorityView, fail: Fail) {
  if (!authority.commerceScope) return;
  const text = normalizeForScreening(raw);
  const prices = [...authority.products.values()].flatMap((p) => (p.price ? [p.price] : []));
  // Amounts are read from the un-folded NFKC text so leetspeak folding can never alter a number.
  for (const m of raw.normalize('NFKC').replace(INVISIBLE, '').matchAll(MONEY)) {
    const amount = Number((m[3] ?? m[4] ?? '').replace(/,/g, ''));
    const currency = moneyCurrency(m[1], m[2], m[5]);
    if (!Number.isFinite(amount)) continue;
    if (prices.length === 0) {
      fail('price_claim_unsupported');
      continue;
    }
    const match = prices.some((p) => Math.abs(p.amount - amount) < 0.005 && (currency === null || currency === p.currency));
    if (!match) fail('price_claim_mismatch');
  }
  for (const sentence of splitSentences(text)) {
    for (const clause of splitClauses(sentence)) {
      if (!AVAILABILITY_CLAIM.test(clause) || /\?\s*$/.test(sentence) || EPISTEMIC.test(clause)) continue;
      const positiveInStock = /\b(?:in stock|available (?:now|today|to (?:buy|order)|for purchase))\b/i.test(clause) &&
        !/\b(?:not|n't|no longer)\b/i.test(clause);
      const supported = positiveInStock && [...authority.products.values()].some((p) => p.availability === 'in_stock');
      if (!supported) fail('availability_claim_unsupported');
    }
  }
}

const ACTION_DONE: readonly RegExp[] = [
  /\b(?:i|we)(?:'ve| have)?(?: just| already| now)?\s+(?:saved|purchased|bought|ordered|booked|reserved|placed (?:an |the |your )?order|subscribed|unsubscribed|cancel(?:l)?ed|submitted|charged|paid|refunded|checked out)\b/i,
  /\b(?:i|we)(?:'ve| have)?(?: just| already| now)?\s+(?:added|put|moved|removed|deleted|pinned)\b[^.!?]{0,60}?\b(?:to|from|in|into|on) your (?:closet|wardrobe|watchlist|cart|bag|wishlist|saved items|favou?rites|collection|board|list|room)\b/i,
  /\b(?:i|we)(?:'ve| have)?(?: just| already| now)?\s+(?:updated|changed|edited|reset|deleted|cancel(?:l)?ed)\s+your (?:account|settings|profile|preferences|password|email|address|plan|subscription|payment|size|notifications|order)\b/i,
  /\b(?:has|have) been\s+(?:successfully\s+)?(?:saved|added|purchased|ordered|booked|placed|reserved|removed|submitted|processed|confirmed|cancel(?:l)?ed|shipped|charged|refunded)\b/i,
  /\byour (?:order|purchase|booking|reservation|payment|refund|return)\b[^.!?]{0,40}?\b(?:is|was|has been)\s+(?:now\s+)?(?:placed|confirmed|complete|completed|processed|on (?:its|the) way|shipped|approved)\b/i,
  /\b(?:it(?:'s| is)|they(?:'re| are)) (?:now |already )?(?:saved )?(?:in|on|to) your (?:closet|watchlist|cart|bag|wishlist|saved items|favou?rites)\b/i,
  /\bi(?:'ll| will) (?:go ahead and|save|add|buy|order|purchase|book|reserve|remove|delete|cancel|subscribe|check ?out|update your|change your)\b/i,
  /\bsuccessfully (?:saved|added|purchased|ordered|booked|placed|updated|removed)\b/i,
];
const CAPABILITY_OFFER =
  /\b(?:let me|i can|i could|shall i|should i|want me to|would you like me to|do you want me to)\s+(?:save|add|buy|order|purchase|book|reserve|check ?out|update your|change your|cancel|subscribe)\b/i;
const ACTION_EXEMPT = /\b(?:can(?:'|no)?t|cannot|unable|not able|won't|will not|you can|you could|tap|in the app|yourself)\b/i;

const COMMITMENT: readonly RegExp[] = [
  /\b(?:we|k ?scan(?: ai)?) (?:guarantee[sd]?|promise[sd]?|warrants?|will (?:refund|reimburse|price[- ]match|replace|compensate|credit|cover|waive))\b/i,
  /\b(?:k ?scan|we|i) (?:can|shall) (?:refund|reimburse|replace|compensate|price[- ]match|waive)\b/i,
  /\b100% (?:refund|guarantee|satisfaction)\b/i,
  /\b(?:k ?scan(?:'s)?|our) (?:money[- ]back|price[- ]match|lowest[- ]price|satisfaction) (?:guarantee|policy|promise)\b/i,
  /\b(?:you(?:'re| are) entitled to|you will (?:get|receive) (?:a )?(?:refund|credit|discount))\b/i,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const PHONE = /(?:^|[^\d$€£¥.,])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const SENSITIVE_PHRASE =
  /\b(?:verification (?:documents?|evidence|records?|files?)|home address|ssn|social security|passport|driver'?s licen[cs]e|(?:owner|founder)(?:'s)? (?:home address|address|phone|email|identity|id|documents?|personal details|details|date of birth))\b/i;
const VERIFIED_OBSERVATION =
  /\b(?:verified|confirmed|certified|guaranteed|definitely|100%)\s+(?:authentic|genuine|real|original|designer|vintage)\b|\bk ?scan (?:has )?(?:verified|confirmed|authenticated|certified) (?:this|that|it|the|your)\b/i;

function checkClaimsAndPrivacy(raw: string, authority: AuthorityView, fail: Fail) {
  const text = normalizeForScreening(raw);
  for (const sentence of splitSentences(text)) {
    // Ownership clauses keep ':' together (a merchant name and its label); action exemptions must not cross it.
    for (const clause of splitClauses(sentence).flatMap((c) => c.split(/\s*:\s*/)).filter(Boolean)) {
      if (ACTION_DONE.some((re) => re.test(clause)) && !ACTION_EXEMPT.test(clause)) fail('unexecuted_action_claim');
      if (CAPABILITY_OFFER.test(clause) && !ACTION_EXEMPT.test(clause)) fail('unsupported_capability_offer');
    }
    // Whole-sentence checks catch claims a clause split would cut in half.
    if (ACTION_DONE.some((re) => re.test(sentence)) && !ACTION_EXEMPT.test(sentence)) fail('unexecuted_action_claim');
    if (COMMITMENT.some((re) => re.test(sentence))) fail('unauthorized_company_commitment');
    if (VERIFIED_OBSERVATION.test(sentence)) fail('observation_presented_as_verified');
  }
  // Identifiers are matched on the NFKC text WITHOUT leet folding (folding '@' would erase an e-mail address).
  const plain = raw.normalize('NFKC').replace(INVISIBLE, '');
  if (EMAIL.test(plain) || UUID.test(plain) || PHONE.test(plain) || SENSITIVE_PHRASE.test(text)) fail('sensitive_data_exposure');
  for (const ref of authority.internalRefs) {
    const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^A-Za-z0-9_-])${esc}(?:[^A-Za-z0-9_-]|$)`).test(raw)) fail('internal_reference_exposure');
  }
}

// ── Stage 1: candidate shape ────────────────────────────────────────────────────

const CANDIDATE_KEYS: ReadonlySet<string> = new Set(['text', 'whyThisWorks', 'finishReason', 'claims']);
const CLAIM_KEYS: Readonly<Record<StructuredClaimV1['type'], readonly string[]>> = Object.freeze({
  ownership_label: ['type', 'merchantRef', 'labelText'],
  merchant_reference: ['type', 'merchantRef', 'productRef'],
  commerce_fact: ['type', 'kind', 'merchantRef', 'productRef', 'value'],
  visual_observation: ['type', 'label', 'confidence'],
  policy_reference: ['type', 'policyRef'],
  action_state: ['type', 'factId', 'state'],
});
const REF_RE = /^[A-Za-z0-9_-]{3,64}$/;
// deno-lint-ignore no-control-regex
const CONTROL_EXCEPT_NEWLINE_TAB = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// deno-lint-ignore no-control-regex
const CONTROL_ANY = /[\x00-\x1F\x7F]/;
const shortString = (v: unknown, max = 120) => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL_ANY.test(v);

function parseClaim(raw: unknown): StructuredClaimV1 | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !Object.prototype.hasOwnProperty.call(CLAIM_KEYS, raw.type)) return null;
  const allowed = CLAIM_KEYS[raw.type as StructuredClaimV1['type']];
  if (Object.keys(raw).some((k) => !allowed.includes(k))) return null;
  const ref = (v: unknown) => typeof v === 'string' && REF_RE.test(v);
  switch (raw.type) {
    case 'ownership_label':
      return ref(raw.merchantRef) && shortString(raw.labelText) ? raw as unknown as StructuredClaimV1 : null;
    case 'merchant_reference':
      return ref(raw.merchantRef) && (raw.productRef === undefined || ref(raw.productRef)) ? raw as unknown as StructuredClaimV1 : null;
    case 'commerce_fact':
      return ['price', 'currency', 'availability'].includes(String(raw.kind)) && ref(raw.merchantRef) && ref(raw.productRef) &&
          shortString(raw.value, 40)
        ? raw as unknown as StructuredClaimV1
        : null;
    case 'visual_observation':
      return shortString(raw.label) && ['low', 'medium', 'high'].includes(String(raw.confidence)) ? raw as unknown as StructuredClaimV1 : null;
    case 'policy_reference':
      return shortString(raw.policyRef, 80) ? raw as unknown as StructuredClaimV1 : null;
    case 'action_state':
      return typeof raw.factId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.factId) && shortString(raw.state, 40)
        ? raw as unknown as StructuredClaimV1
        : null;
  }
  return null;
}

// ── Stage 2: structured claims against the records ──────────────────────────────

function checkStructuredClaims(
  claims: readonly StructuredClaimV1[],
  authority: AuthorityView,
  fail: Fail,
  labels: { emitted: boolean; exact: boolean; merchants: Set<string> },
) {
  const productOwner = new Map<string, string>();
  for (const p of authority.products.values()) productOwner.set(p.productRef, p.merchantRef);
  const claimedOwner = new Map<string, string>();
  const labelTextByMerchant = new Map<string, string>();
  for (const claim of claims) {
    switch (claim.type) {
      case 'ownership_label': {
        labels.emitted = true;
        if (!authority.ownershipAuthority) {
          labels.exact = false;
          fail('label_on_task_without_ownership_authority');
          break;
        }
        const merchant = authority.eligible.get(claim.merchantRef);
        if (!merchant) {
          labels.exact = false;
          fail('label_merchant_not_eligible');
          break;
        }
        const prior = labelTextByMerchant.get(claim.merchantRef);
        if (prior !== undefined && prior !== claim.labelText) fail('conflicting_merchant_references');
        labelTextByMerchant.set(claim.merchantRef, claim.labelText);
        if (claim.labelText !== merchant.labelFact.value) {
          labels.exact = false;
          fail('label_text_altered');
          break;
        }
        labels.merchants.add(claim.merchantRef);
        break;
      }
      case 'merchant_reference': {
        if (!authority.eligible.has(claim.merchantRef)) {
          fail('merchant_reference_not_eligible');
          break;
        }
        if (claim.productRef !== undefined) {
          const owner = productOwner.get(claim.productRef);
          if (owner === undefined) fail('commerce_fact_unsupported');
          else if (owner !== claim.merchantRef) fail('merchant_attribution_transfer');
          const prior = claimedOwner.get(claim.productRef);
          if (prior !== undefined && prior !== claim.merchantRef) fail('conflicting_merchant_references');
          claimedOwner.set(claim.productRef, claim.merchantRef);
        }
        labels.merchants.add(claim.merchantRef);
        break;
      }
      case 'commerce_fact': {
        const owner = productOwner.get(claim.productRef);
        if (owner !== undefined && owner !== claim.merchantRef) {
          fail('merchant_attribution_transfer');
          break;
        }
        const p = authority.products.get(`${claim.merchantRef}|${claim.productRef}`);
        const authoritative = !p
          ? undefined
          : claim.kind === 'price'
          ? p.price?.value
          : claim.kind === 'currency'
          ? (p.price ? p.currency : undefined)
          : p.availability;
        if (authoritative === undefined) fail('commerce_fact_unsupported');
        else if (authoritative !== claim.value) fail('commerce_fact_mismatch');
        break;
      }
      case 'visual_observation':
        if (/\b(?:verified|confirmed|certified|authentic|genuine|guaranteed)\b/i.test(normalizeForScreening(claim.label))) {
          fail('observation_presented_as_verified');
        }
        break;
      case 'policy_reference':
        if (!authority.policyRefs.has(claim.policyRef)) fail('policy_reference_not_in_task');
        break;
      case 'action_state':
        // A model statement is never an execution record; it may only quote one exactly.
        if (authority.actionFacts.get(claim.factId) !== claim.state) fail('action_state_without_record');
        break;
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────────

function stageOf(detail: OutputDetailCode): ValidationStage {
  if (detail === 'task_contract_rejected') return 'stage0_server_authority';
  if (DETAIL_TO_FAILURE[detail] === 'output_contract_violation') return 'stage1_output_contract';
  const stage2: readonly OutputDetailCode[] = [
    'label_merchant_not_eligible', 'label_text_altered', 'label_on_task_without_ownership_authority', 'merchant_reference_not_eligible',
    'merchant_attribution_transfer', 'conflicting_merchant_references', 'commerce_fact_unsupported', 'commerce_fact_mismatch',
    'policy_reference_not_in_task', 'action_state_without_record', 'price_claim_unsupported', 'price_claim_mismatch',
    'availability_claim_unsupported',
  ];
  return stage2.includes(detail) ? 'stage2_verified_fact_integrity' : 'stage3_claims_and_register';
}

/**
 * Validates one candidate against the task. Deterministic and side-effect free. The same (task, candidate, registry, now)
 * gives the same result for every `origin`.
 */
export function validateCorporateOutput(input: ValidateOutputInput): OutputValidationResult {
  const details: OutputDetailCode[] = [];
  const fail: Fail = (d) => {
    if (!details.includes(d)) details.push(d);
  };
  const finish = (labels: ServerRenderedLabel[], emitted: boolean, exact: boolean | null, eligibleCount: number): OutputValidationResult => {
    const failures = details.map((detail) => ({ code: DETAIL_TO_FAILURE[detail], detail }));
    const codes = new Set(failures.map((f) => f.code));
    const primaryFailure = FAILURE_PRIORITY.find((c) => codes.has(c)) ?? null;
    const stageRank = (s: ValidationStage) => ['stage0_server_authority', 'stage1_output_contract', 'stage2_verified_fact_integrity', 'stage3_claims_and_register'].indexOf(s);
    const stage = details.length === 0
      ? 'stage3_claims_and_register'
      : details.map(stageOf).sort((a, b) => stageRank(a) - stageRank(b))[0];
    return {
      verdict: details.length === 0 ? 'accept' : 'reject',
      stage,
      failures,
      primaryFailure,
      labels: details.length === 0 ? labels : [],
      modelLabelEmitted: emitted,
      modelLabelExactMatch: emitted ? exact : null,
      eligibleMerchantsAtValidation: eligibleCount,
    };
  };

  // Stage 0: the task is the only authority, so it is re-validated here (defence in depth) at validation time.
  const nowMs = input.now instanceof Date ? input.now.getTime() : NaN;
  const taskResult = Number.isFinite(nowMs) ? validateCorporateTaskV1(input.task, input.now) : null;
  if (!taskResult || !taskResult.ok) {
    fail('task_contract_rejected');
    return finish([], false, null, 0);
  }
  const task = taskResult.value;
  if (task.brandPolicyVersion !== CORPORATE_CHARTER_VERSION) {
    fail('task_contract_rejected');
    return finish([], false, null, 0);
  }
  const authority = buildAuthority(task, nowMs);
  const eligibleCount = authority.eligible.size;
  const knownKeys = (Array.isArray(input.registry?.knownMerchantNames) ? input.registry.knownMerchantNames : [])
    .filter((n): n is string => typeof n === 'string')
    .map((n) => normalizeForScreening(n).toLowerCase().trim())
    .filter((n) => n.length >= 2);

  // Stage 1: closed candidate shape.
  const c = input.candidate;
  if (!isRecord(c)) {
    fail('candidate_not_object');
    return finish([], false, null, eligibleCount);
  }
  if (Object.keys(c).some((k) => !CANDIDATE_KEYS.has(k))) fail('candidate_unknown_field');
  if (!rejectForbiddenModelShape(c).ok) fail('candidate_forbidden_shape');
  if (typeof c.text !== 'string') fail('text_not_string');
  else {
    if (c.text.trim().length === 0) fail('empty_text');
    if (c.text.length > MAX_OUTPUT_CHARS) fail('text_too_long');
    if (CONTROL_EXCEPT_NEWLINE_TAB.test(c.text)) fail('text_control_characters');
  }
  if (c.whyThisWorks !== undefined &&
    (typeof c.whyThisWorks !== 'string' || c.whyThisWorks.length > MAX_WHY_CHARS || CONTROL_EXCEPT_NEWLINE_TAB.test(c.whyThisWorks))) {
    fail('why_invalid');
  }
  if (c.finishReason !== undefined && (typeof c.finishReason !== 'string' || /^MAX_TOKENS$/i.test(c.finishReason))) {
    fail('truncated_output');
  }
  const claims: StructuredClaimV1[] = [];
  if (c.claims !== undefined) {
    if (!Array.isArray(c.claims)) fail('claims_not_array');
    else if (c.claims.length > MAX_STRUCTURED_CLAIMS) fail('too_many_claims');
    else {
      for (const raw of c.claims) {
        const parsed = parseClaim(raw);
        if (!parsed) fail('claim_malformed');
        else claims.push(parsed);
      }
    }
  }
  if (details.length > 0) return finish([], false, null, eligibleCount);

  // Stage 2 (structured) + Stage 2/3 (prose). Both documents the customer sees are screened.
  const labelState = { emitted: false, exact: true, merchants: new Set<string>() };
  checkStructuredClaims(claims, authority, fail, labelState);
  const documents = [c.text as string, ...(typeof c.whyThisWorks === 'string' && c.whyThisWorks.trim() ? [c.whyThisWorks] : [])];
  for (const doc of documents) {
    const own = checkOwnershipProse(doc, authority, knownKeys, fail);
    if (own.labelEmitted) labelState.emitted = true;
    if (!own.labelExact) labelState.exact = false;
    for (const ref of own.boundMerchants) labelState.merchants.add(ref);
    checkMerchantRecommendations(doc, authority, knownKeys, fail);
    checkCommerceProse(doc, authority, fail);
    checkClaimsAndPrivacy(doc, authority, fail);
  }

  const labels: ServerRenderedLabel[] = [...labelState.merchants]
    .map((ref) => authority.eligible.get(ref))
    .filter((m): m is EligibleMerchant => m !== undefined)
    .sort((a, b) => a.merchantRef.localeCompare(b.merchantRef))
    .map((m) => ({
      merchantRef: m.merchantRef,
      labelFactId: m.labelFact.factId,
      sourceRecordRef: m.labelFact.sourceRecordRef,
      labelText: m.labelFact.value,
    }));
  return finish(labels, labelState.emitted, labelState.exact, eligibleCount);
}
