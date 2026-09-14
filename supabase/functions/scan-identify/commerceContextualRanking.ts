/**
 * Contextual Commerce ranking extension (Build 35).
 *
 * SINGLE RANKING AUTHORITY. This is not a second ranker. It supplies two
 * things to the one that already exists in
 * `qualityTuneCommerce.filterAndDedupeProducts`:
 *
 *   Stage A  -- additional HARD constraints, evaluated alongside the existing
 *               shape/URL/image/category filters. A constraint violation is
 *               never rescued by a high style score.
 *   Stage B  -- a bounded DELTA added to the score `scoreProductAgreement`
 *               already produced. The fashion-match signal is unchanged; this
 *               only adds the user/situational half that was missing.
 *
 * Stage C (the existing deterministic tie-break and soft retailer diversity
 * rerank) is untouched: nothing here reads `source`, `retailer`, a provider
 * name, a domain, or an affiliate field, and no candidate gains a point for
 * having richer metadata than another.
 *
 * COMMERCIAL USABILITY IS A FLOOR, NOT A BOOST. `classifyCommercialUsability`
 * decides whether a listing can carry a transaction, and that decision gates
 * the Buy action and the primary-recommendation slot. It contributes ZERO to
 * the score, deliberately: feed completeness correlates with retailer, so
 * scoring it would be a retailer preference wearing a relevance costume.
 *
 * PRODUCT TEXT IS DATA. Every provider-supplied string reaching this module is
 * matched against fixed token lists and compared as text. Nothing here
 * interprets a title as an instruction, and no title can create availability,
 * ownership, or a price.
 */

import type { RecommendedProduct } from './shoppingProvider.ts';
import { parseNumericPrice } from './commerceRelevanceAgreement.ts';
import { normalizeCurrencyCode } from './offerCurrency.ts';
import type { ShoppingIntent } from './commerceShoppingIntent.ts';

export const CONTEXTUAL_COMMERCE_VERSION = 'ctx-v1';

// ── Commercial usability ────────────────────────────────────────────────────

/**
 * What a listing can actually be used for. Names differ from the mission
 * brief's wording only where an existing K Scan term already fits.
 */
export type CommercialUsability =
  | 'TRANSACTION_READY'
  | 'BROWSE_ONLY'
  | 'UNUSABLE'
  | 'UNKNOWN';

const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Is this URL safe to hand to a browser as a purchase destination?
 *
 * Mirrors `services/commerceDestination.isSafeCommerceUrl` (HTTPS only, no
 * embedded credentials, no internal network target). The server's existing
 * `hasValidPurchaseUrl` is deliberately more permissive -- it also admits
 * `http:` -- so a listing can pass the existing Stage A filter and still be
 * something the client will refuse to open. That gap is exactly what this
 * classification exists to describe honestly rather than hide.
 */
function isTransactableUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return false;
    if (PRIVATE_HOST.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify one listing's transactional usability from COMMERCIAL FACTS only.
 *
 *   UNUSABLE          -- no destination a purchase could happen at.
 *   BROWSE_ONLY       -- a real page, but not an offer: `type: 'similar'` is
 *                        the existing contract's own SAME-vs-SIMILAR line, and
 *                        a similar link is something to look at, not to buy.
 *   UNKNOWN           -- an offer whose price the provider never stated. It is
 *                        still shoppable, but nothing may describe its
 *                        availability or price, and it is never relabelled
 *                        "in stock".
 *   TRANSACTION_READY -- a retail offer, a safe destination, a real price.
 *
 * Availability is read ONLY from a provider-declared field. An absent
 * availability is UNKNOWN and stays UNKNOWN.
 */
export function classifyCommercialUsability(product: RecommendedProduct | null | undefined): CommercialUsability {
  if (!product || typeof product !== 'object') return 'UNUSABLE';
  const rec = product as unknown as Record<string, unknown>;

  if (!isTransactableUrl(product.productUrl)) return 'UNUSABLE';

  const declaredAvailability = typeof rec.availability === 'string'
    ? rec.availability.trim().toLowerCase()
    : '';
  if (declaredAvailability === 'out_of_stock' || declaredAvailability === 'outofstock' || declaredAvailability === 'sold_out') {
    return 'BROWSE_ONLY';
  }

  if (product.type !== 'retail') return 'BROWSE_ONLY';

  const price = parseNumericPrice(product.price);
  if (price.kind !== 'valid') return 'UNKNOWN';

  return 'TRANSACTION_READY';
}

/** Only a TRANSACTION_READY listing may render an active Buy/Shop control. */
export function canActivateTransaction(usability: CommercialUsability): boolean {
  return usability === 'TRANSACTION_READY';
}

/**
 * The primary transactional recommendation: the FIRST already-ranked candidate
 * that can actually carry a transaction.
 *
 * Order is not changed. This selects within the existing ranking rather than
 * re-sorting by usability, so metadata completeness still cannot move a
 * listing up the shelf. Returns -1 when nothing in the set is transactable.
 */
export function selectPrimaryTransactionalIndex(
  products: readonly RecommendedProduct[],
): number {
  for (let i = 0; i < products.length; i += 1) {
    if (classifyCommercialUsability(products[i]) === 'TRANSACTION_READY') return i;
  }
  return -1;
}

// ── Price comparability ─────────────────────────────────────────────────────

export interface ComparablePrice {
  amount: number;
  currency: string;
}

/**
 * A listing's price ONLY when both halves are facts: an amount that parses and
 * a currency the provider declared. A symbol inside the price string is never
 * read as a currency declaration -- `offerCurrency.ts` established that a
 * currency is only ever what the provider said, and inferring one here would
 * reintroduce exactly the fabricated-USD defect that module was built to stop.
 */
export function comparablePrice(product: RecommendedProduct | null | undefined): ComparablePrice | null {
  if (!product) return null;
  const parsed = parseNumericPrice(product.price);
  if (parsed.kind !== 'valid' || parsed.value === null) return null;
  const currency = normalizeCurrencyCode((product as unknown as Record<string, unknown>).currency);
  if (!currency) return null;
  return { amount: parsed.value, currency };
}

/**
 * True only when every listed candidate carries a price in the SAME known
 * currency. This is the gate for any comparative claim -- "best value",
 * "cheapest", "lowest price". Two candidates priced in different currencies,
 * or one priced with no declared currency, are not comparable, and a ranking
 * position is not a price comparison.
 */
export function candidatesArePriceComparable(products: readonly RecommendedProduct[]): boolean {
  if (!products || products.length < 2) return false;
  let currency: string | null = null;
  for (const p of products) {
    const price = comparablePrice(p);
    if (!price) return false;
    if (currency === null) currency = price.currency;
    else if (currency !== price.currency) return false;
  }
  return true;
}

export type BudgetFit = 'within' | 'over' | 'unknown';

/**
 * Where one listing sits against an explicit ceiling.
 *
 * `unknown` is a real answer, not a soft "probably fine": a listing whose
 * currency the provider never declared cannot be proven to satisfy a ceiling,
 * and must never be presented as though it does.
 */
export function evaluateBudgetFit(
  product: RecommendedProduct,
  intent: ShoppingIntent,
): BudgetFit {
  const ceiling = intent.budgetCeiling?.value;
  if (!ceiling) return 'unknown';
  const price = comparablePrice(product);
  if (!price) return 'unknown';
  if (price.currency !== ceiling.currency) return 'unknown';
  return price.amount <= ceiling.amount ? 'within' : 'over';
}

// ── Stage A: contextual hard constraints ────────────────────────────────────

export type HardConstraintCode =
  | 'explicit_exclusion_violation'
  | 'budget_ceiling_violation'
  | 'forged_ownership_claim';

export interface HardConstraintResult {
  violated: boolean;
  codes: HardConstraintCode[];
}

const NO_VIOLATION: HardConstraintResult = Object.freeze({ violated: false, codes: [] });

/** The candidate's own searchable text. Provider content, treated as data. */
function candidateText(product: RecommendedProduct): string {
  const rec = product as unknown as Record<string, unknown>;
  return [
    typeof product.title === 'string' ? product.title : '',
    typeof rec.category === 'string' ? rec.category : '',
    typeof rec.item_type === 'string' ? rec.item_type : '',
    typeof rec.material === 'string' ? rec.material : '',
    typeof rec.color === 'string' ? rec.color : '',
    typeof product.type === 'string' ? product.type : '',
  ].join(' ').toLowerCase();
}

/**
 * Does this listing claim to be something the user already owns?
 *
 * A Commerce candidate is external by definition. Any ownership assertion
 * arriving on one -- `owned`, `inCloset`, `relationship: 'owned'`,
 * `actorRelationship: 'owned'` -- was not written by the Closet ownership
 * flow, because that flow does not produce retailer listings. It is therefore
 * either provider noise or a forged field, and in both cases the claim is
 * rejected rather than believed.
 */
export function hasForgedOwnershipClaim(product: RecommendedProduct | null | undefined): boolean {
  if (!product || typeof product !== 'object') return false;
  const rec = product as unknown as Record<string, unknown>;
  if (rec.owned === true || rec.inCloset === true || rec.isOwned === true) return true;
  const relationship = typeof rec.relationship === 'string' ? rec.relationship.toLowerCase() : '';
  const actorRelationship = typeof rec.actorRelationship === 'string'
    ? rec.actorRelationship.toLowerCase()
    : '';
  return relationship === 'owned' || actorRelationship === 'owned';
}

/**
 * Strip an unverifiable ownership assertion, leaving the listing itself intact.
 *
 * Preferred over dropping the candidate: the OFFER is real even when the
 * ownership field attached to it is not, and refusing to show a genuine
 * retailer listing because a provider set a stray boolean would punish the
 * user for the provider's mistake. The claim dies; the product survives, with
 * `relationship: 'external'` -- the same word Packing already uses for "not
 * yours".
 */
export function stripOwnershipClaim<T extends RecommendedProduct>(product: T): T {
  if (!hasForgedOwnershipClaim(product)) return product;
  const clone = { ...(product as unknown as Record<string, unknown>) };
  delete clone.owned;
  delete clone.inCloset;
  delete clone.isOwned;
  delete clone.actorRelationship;
  clone.relationship = 'external';
  return clone as unknown as T;
}

/**
 * Evaluate the contextual hard constraints for one candidate.
 *
 * These cannot be outscored. A candidate that violates an explicit exclusion
 * or a stated budget ceiling is not a worse answer to the question -- it is an
 * answer to a different question.
 */
export function evaluateHardConstraints(
  product: RecommendedProduct,
  intent: ShoppingIntent,
): HardConstraintResult {
  if (!product || !intent) return NO_VIOLATION;
  const codes: HardConstraintCode[] = [];
  const text = candidateText(product);

  for (const exclusion of intent.exclusions) {
    // Word-boundary match: "leather" must not fire on "leatherette-free", and
    // a substring hit inside an unrelated word is not evidence.
    const pattern = new RegExp(`\\b${exclusion.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(text)) {
      codes.push('explicit_exclusion_violation');
      break;
    }
  }

  if (evaluateBudgetFit(product, intent) === 'over') {
    codes.push('budget_ceiling_violation');
  }

  if (hasForgedOwnershipClaim(product)) {
    codes.push('forged_ownership_claim');
  }

  return codes.length ? { violated: true, codes } : NO_VIOLATION;
}

// ── Stage B: bounded contextual delta ───────────────────────────────────────

/**
 * Weights. Deliberately smaller than the fashion-match weights they sit
 * alongside (`AGREEMENT_EXACT_CATEGORY` is 30) with ONE exception: an explicit
 * user attribute override is worth more than the scan-derived attribute it
 * replaces, because the whole point of "in red instead" is that the user
 * outranks the photograph.
 */
export const CTX_EXPLICIT_ATTRIBUTE_MATCH = 22;
export const CTX_EXPLICIT_ATTRIBUTE_MISS = -18;

/**
 * A STRONG explicit request elevates further. It does not suppress further.
 *
 * "Only black" and "black shoes" are both positive requests; the difference
 * between them is how far a black candidate rises, not how far a brown one
 * falls. That asymmetry is the whole mechanism: a positive request must never
 * become a disguised exclusion, because the customer who says "only black" and
 * is shown nothing else has lost the market, and the one who is shown a brown
 * boot ranked second has lost nothing.
 *
 * The miss penalty is deliberately SHARED between the two tiers, and is the
 * one the ordinary tier already used. Adding a second, harsher penalty for the
 * strong tier is the obvious-looking change and is exactly the suppression
 * this contract exists to refuse.
 */
export const CTX_STRONG_EXPLICIT_ATTRIBUTE_MATCH = 34;
export const CTX_FUNCTIONAL_REQUIREMENT_MATCH = 12;
export const CTX_CONFIRMED_GAP_ALIGNMENT = 10;
export const CTX_OCCASION_OR_FORMALITY_MATCH = 6;
export const CTX_SIGNATURE_STYLE_PREFERENCE = 3;
export const CTX_DUPLICATE_OF_OWNED = -14;
export const CTX_BUDGET_WITHIN = 4;

/** Bound on the whole contextual contribution, so context can never swamp fit. */
export const CTX_DELTA_MIN = -40;
export const CTX_DELTA_MAX = 40;

export type RationaleFactCode =
  | 'explicit_color_match'
  | 'explicit_material_match'
  | 'explicit_silhouette_match'
  | 'explicit_attribute_missing'
  | 'functional_requirement_met'
  | 'confirmed_gap_match'
  | 'unconfirmed_gap_context'
  | 'occasion_match'
  | 'formality_match'
  | 'signature_style_aligned'
  | 'duplicate_of_owned'
  | 'budget_within'
  | 'budget_unknown';

export interface ContextualScoreResult {
  /** Bounded delta applied to the existing agreement score. */
  delta: number;
  /** Deterministic, evidence-backed facts. Never prose. */
  facts: RationaleFactCode[];
  /** Attribute tokens that actually matched, for rationale rendering. */
  matchedAttributes: string[];
}

const EMPTY_SCORE: ContextualScoreResult = Object.freeze({ delta: 0, facts: [], matchedAttributes: [] });

function includesToken(text: string, token: string): boolean {
  if (!token) return false;
  const pattern = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return pattern.test(text);
}

/**
 * Score the USER/SITUATIONAL half of the ranking objective.
 *
 * Reads only the intent and the candidate's own declared text. Never reads
 * `source`, `retailer`, provider order, metadata richness, or price magnitude
 * (beyond the pass/fail budget fit), so nothing here can express a retailer
 * preference or reward a fuller feed.
 */
export function scoreContextualFit(
  product: RecommendedProduct,
  intent: ShoppingIntent,
): ContextualScoreResult {
  if (!product || !intent) return EMPTY_SCORE;
  const text = candidateText(product);
  const facts: RationaleFactCode[] = [];
  const matchedAttributes: string[] = [];
  let delta = 0;

  // Explicit attribute overrides. Present only when the USER said them, so a
  // scan-derived colour never reaches this branch and never double-counts
  // against the agreement score that already read it.
  const explicitAxes: Array<{ field: typeof intent.color; fact: RationaleFactCode }> = [
    { field: intent.color, fact: 'explicit_color_match' },
    { field: intent.material, fact: 'explicit_material_match' },
    { field: intent.silhouette, fact: 'explicit_silhouette_match' },
  ];
  let sawExplicitAxis = false;
  let missedExplicitAxis = false;
  for (const axis of explicitAxes) {
    if (!axis.field || axis.field.provenance !== 'USER_EXPLICIT') continue;
    sawExplicitAxis = true;
    if (includesToken(text, axis.field.value)) {
      delta += axis.field.strength === 'STRONG_EXPLICIT_PREFERENCE'
        ? CTX_STRONG_EXPLICIT_ATTRIBUTE_MATCH
        : CTX_EXPLICIT_ATTRIBUTE_MATCH;
      facts.push(axis.fact);
      matchedAttributes.push(axis.field.value);
    } else {
      missedExplicitAxis = true;
    }
  }
  if (sawExplicitAxis && missedExplicitAxis) {
    delta += CTX_EXPLICIT_ATTRIBUTE_MISS;
    facts.push('explicit_attribute_missing');
  }

  for (const requirement of intent.functionalRequirements) {
    if (!includesToken(text, requirement.value)) continue;
    delta += CTX_FUNCTIONAL_REQUIREMENT_MATCH;
    facts.push('functional_requirement_met');
    matchedAttributes.push(requirement.value);
  }

  // Gap alignment. A CONFIRMED gap is evidence the user needs this role, so it
  // may move ranking. An UNCONFIRMED gap is Packing saying "I can't tell" --
  // it is recorded as context for the explanation and is worth ZERO points,
  // because scoring an unproven absence is how uncertainty quietly becomes
  // certainty.
  const gap = intent.gapRelationship?.value;
  if (gap) {
    const gapTokens = gap.label.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3);
    const gapMatched = gapTokens.some((t) => includesToken(text, t));
    if (gap.certainty === 'confirmed' && gapMatched) {
      delta += CTX_CONFIRMED_GAP_ALIGNMENT;
      facts.push('confirmed_gap_match');
    } else if (gap.certainty === 'unconfirmed') {
      facts.push('unconfirmed_gap_context');
    }
  }

  if (intent.occasion && includesToken(text, intent.occasion.value)) {
    delta += CTX_OCCASION_OR_FORMALITY_MATCH;
    facts.push('occasion_match');
    matchedAttributes.push(intent.occasion.value);
  }
  if (intent.formality && includesToken(text, intent.formality.value)) {
    delta += CTX_OCCASION_OR_FORMALITY_MATCH;
    facts.push('formality_match');
    matchedAttributes.push(intent.formality.value);
  }

  // Duplication risk. Owning something very close is a reason to rank a
  // near-identical listing lower, never a reason to hide it: the user may be
  // replacing a worn-out piece, so this is a penalty, not a filter.
  for (const owned of intent.relevantOwned) {
    const colorMatch = owned.color ? includesToken(text, owned.color) : false;
    const materialMatch = owned.material ? includesToken(text, owned.material) : false;
    const categoryMatch = owned.category ? includesToken(text, owned.category) : false;
    if ((colorMatch && materialMatch) || (colorMatch && categoryMatch && materialMatch)) {
      delta += CTX_DUPLICATE_OF_OWNED;
      facts.push('duplicate_of_owned');
      break;
    }
  }

  // Signature Style is a PREFERENCE. Its weight is the smallest here by
  // design: an explicit request outranks it, which is the behaviour the
  // stylist prompt already promises in words.
  for (const token of intent.signatureStyleTokens) {
    if (!includesToken(text, token)) continue;
    delta += CTX_SIGNATURE_STYLE_PREFERENCE;
    facts.push('signature_style_aligned');
    matchedAttributes.push(token);
    break;
  }

  if (intent.budgetCeiling) {
    const fit = evaluateBudgetFit(product, intent);
    if (fit === 'within') {
      delta += CTX_BUDGET_WITHIN;
      facts.push('budget_within');
    } else if (fit === 'unknown') {
      facts.push('budget_unknown');
    }
  }

  const bounded = Math.max(CTX_DELTA_MIN, Math.min(CTX_DELTA_MAX, Math.round(delta)));
  return { delta: bounded, facts, matchedAttributes };
}

// ── Rationale facts (Commerce-owned; Elise renders, never re-derives) ───────

export interface CommerceRationaleFacts {
  matchedAttributes: string[];
  factCodes: RationaleFactCode[];
  budgetFit: BudgetFit;
  usability: CommercialUsability;
  /** Packing's certainty, copied verbatim. Commerce never upgrades it. */
  gap: { gapCode: string; certainty: 'confirmed' | 'unconfirmed' } | null;
  /** Always `external`: a Commerce candidate is never in the user's Closet. */
  relationship: 'external';
  /** True only when a same-currency comparison across the set is possible. */
  priceComparable: boolean;
}

/**
 * The structured facts behind one recommendation.
 *
 * ONE set of facts, two renderings: the product UI shows them directly, and
 * Elise turns the same facts into conversational language. There is no second
 * explanation pipeline and no LLM call here -- an explanation that cannot be
 * derived from these fields is an explanation K Scan cannot support.
 */
export function buildRationaleFacts(
  product: RecommendedProduct,
  intent: ShoppingIntent,
  contextual: ContextualScoreResult,
  priceComparable: boolean,
): CommerceRationaleFacts {
  const gap = intent.gapRelationship?.value ?? null;
  return {
    matchedAttributes: contextual.matchedAttributes.slice(0, 6),
    factCodes: contextual.facts.slice(0, 8),
    budgetFit: intent.budgetCeiling ? evaluateBudgetFit(product, intent) : 'unknown',
    usability: classifyCommercialUsability(product),
    gap: gap ? { gapCode: gap.gapCode, certainty: gap.certainty } : null,
    relationship: 'external',
    priceComparable,
  };
}

/**
 * Deterministic labels. A label is emitted only when the data proves it.
 *
 * `BEST VALUE` is absent by design unless every candidate is priced in the
 * same known currency; `CLOSEST VISUAL MATCH` is absent entirely, because this
 * build has no visual signal to support it.
 */
export type RecommendationLabel = 'BEST MATCH' | 'UNDER BUDGET' | 'MORE VERSATILE' | 'BEST VALUE';

export function deriveRecommendationLabel(input: {
  rankIndex: number;
  facts: CommerceRationaleFacts;
  isCheapestComparable: boolean;
}): RecommendationLabel | null {
  if (input.rankIndex === 0 && input.facts.usability === 'TRANSACTION_READY') return 'BEST MATCH';
  if (input.facts.budgetFit === 'within') return 'UNDER BUDGET';
  if (input.isCheapestComparable && input.facts.priceComparable) return 'BEST VALUE';
  if (input.facts.factCodes.includes('occasion_match') || input.facts.factCodes.includes('formality_match')) {
    return 'MORE VERSATILE';
  }
  return null;
}

/**
 * Attach `commercialUsability` to every product at the RESPONSE BOUNDARY.
 *
 * Same array, same order, same existing fields plus one — modelled on
 * `watchlistCapability.attachCommercialUsability`'s sibling
 * `attachWatchCapability`, and for the same reason: an annotation applied
 * after ranking is final can never influence ranking, dedupe, or what Recent
 * Scans persists.
 *
 * This is the floor, not a boost. It decides what a listing may DO (render a
 * Buy control, occupy the primary transactional slot), never where it sits.
 */
export function attachCommercialUsability<T>(
  products: T[],
): (T & { commercialUsability: CommercialUsability })[] {
  return (products ?? []).map((p) => ({
    ...p,
    commercialUsability: classifyCommercialUsability(p as unknown as RecommendedProduct),
  }));
}
