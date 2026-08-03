/**
 * Product Match Foundation V1 — evidence collection and tier assignment.
 *
 * THE CENTRAL RULE
 *
 * A tier is a claim about the world, so each tier states what must be true
 * before it may be asserted. Confidence is computed from evidence weights and
 * used for ORDERING; it is never sufficient on its own to reach a tier. A high
 * score with the wrong kind of evidence stays in a lower tier. This is what
 * stops a very confident SIMILAR from being rendered as an EXACT.
 *
 *   EXACT              DECISIVE, AUTHORITATIVE IDENTITY EVIDENCE, plus brand
 *                      agreement. Two routes qualify:
 *                        (a) an authoritative identifier — verified GTIN,
 *                            manufacturer style code, first-party manufacturer
 *                            record. Sufficient ALONE; no second provider.
 *                        (b) the same identifier corroborated by two
 *                            independent id-bearing catalogues.
 *                      (a) is the durable definition; (b) is the stand-in
 *                      available today. Unreachable by inference, and
 *                      unreachable from a single retailer's own catalogue id —
 *                      Farfetch saying "item 19334521" identifies a row in
 *                      Farfetch's database, not the item in the photograph.
 *
 *                      Independently of the gate, exact CLAIMS are disabled by
 *                      default (PRODUCT_MATCH_EXACT_CLAIMS_ENABLED) and are
 *                      reported as LIKELY_EXACT until the evidence paths are
 *                      validated end to end. See `applyExactClaimPolicy`.
 *
 *   LIKELY_EXACT       Brand established (visible text or a provider-labelled
 *                      brand), the model token agrees, and the colourway
 *                      agrees. "We are confident which product, and which one
 *                      of it, but nothing handed us a SKU."
 *
 *   PRODUCT_FAMILY     Brand and model agree; colourway is unknown or differs.
 *                      "The right product, possibly the wrong colour."
 *
 *   SIMILAR            Category agrees, plus at least one further attribute
 *                      (colour, material, silhouette, pattern). "Not this
 *                      product, but a defensible alternative."
 *
 *   NO_CONFIDENT_MATCH Everything else. Returned, not hidden, because a caller
 *                      needs to distinguish "we found nothing" from "we did not
 *                      run".
 *
 * LATENCY MUST NOT TOUCH THIS FILE
 *
 * Nothing here reads a clock or a deadline. A listing that arrived at 300 ms
 * and one that arrived at 7 s are scored identically. That is the concrete
 * meaning of "do not weaken confidence rules to meet latency targets": the
 * orchestrator may decide to stop waiting, but it can never decide that a
 * late-but-weak match is good enough to fill a gap.
 */

import type {
  EvidenceKind,
  MatchEvidence,
  MatchTier,
  ProductMatchQuery,
} from './contracts.ts';
import { sourceCanCarryExactId } from './contracts.ts';
import type { DedupedFamily, DedupedVariant } from './dedupe.ts';
import { contentTokens, normalizeBrand, normalizeColor, normalizeText, slugify } from './identity.ts';

/**
 * Contribution of each evidence kind to the ordering score.
 *
 * Declared in one table so the entire scoring surface is reviewable at a
 * glance. These are ordering weights only — see the file header.
 */
export const EVIDENCE_WEIGHTS: Record<EvidenceKind, number> = {
  authoritative_product_id: 0.50,
  corroborated_product_id: 0.45,
  exact_product_id: 0.30,
  visible_brand_text: 0.20,
  brand_guess: 0.10,
  model_token: 0.15,
  colorway: 0.12,
  category: 0.08,
  material: 0.05,
  silhouette: 0.05,
  pattern: 0.04,
  cross_source_agreement: 0.06,
};

export type TierAssessment = {
  tier: MatchTier;
  confidence: number;
  evidence: MatchEvidence[];
};

function has(evidence: MatchEvidence[], kind: EvidenceKind): boolean {
  return evidence.some((item) => item.kind === kind);
}

function push(evidence: MatchEvidence[], kind: EvidenceKind, detail?: string): void {
  evidence.push({ kind, weight: EVIDENCE_WEIGHTS[kind], ...(detail ? { detail } : {}) });
}

/**
 * True when every token of `needle` appears in `haystack`.
 *
 * Whole-token containment rather than substring matching: `"air force"` must
 * not match `"airforce one air freshener"` on a shared substring, and `"puma"`
 * must not match `"pumice"`.
 */
function tokensContained(needle: unknown, haystack: unknown): boolean {
  const needleTokens = contentTokens(needle);
  if (needleTokens.length === 0) return false;
  const haystackTokens = new Set(contentTokens(haystack));
  return needleTokens.every((token) => haystackTokens.has(token));
}

/**
 * Gathers every independently checkable agreement between the query and one
 * deduped variant.
 *
 * The variant's own listings are the text surface: a title is what the retailer
 * says the product is. The query is what the scanner says the photographed item
 * is. Evidence is an agreement between the two, never a property of one alone.
 */
export function collectEvidence(input: {
  query: ProductMatchQuery;
  family: DedupedFamily;
  variant: DedupedVariant;
}): MatchEvidence[] {
  const { query, family, variant } = input;
  const evidence: MatchEvidence[] = [];

  const titles = variant.listings.map((listing) => listing.title).join(' ');

  // ── Brand ───────────────────────────────────────────────────────────────
  const visibleBrand = normalizeBrand(query.visibleBrandText);
  const guessedBrand = normalizeBrand(query.brand);
  const listingBrand = family.brand;

  if (visibleBrand && (listingBrand === visibleBrand || tokensContained(query.visibleBrandText, titles))) {
    push(evidence, 'visible_brand_text', visibleBrand);
  } else if (guessedBrand && (listingBrand === guessedBrand || tokensContained(query.brand, titles))) {
    push(evidence, 'brand_guess', guessedBrand);
  }

  // ── Model ───────────────────────────────────────────────────────────────
  // A query model is only credited when the listing text independently carries
  // it. Family.model is derived FROM the listing title, so comparing the query
  // to family.model and to the titles is the same check by two routes; both are
  // required to agree with the query, not with each other.
  if (query.model && (tokensContained(query.model, titles) || slugify(query.model) === family.model)) {
    push(evidence, 'model_token', slugify(query.model));
  }

  // ── Colourway ───────────────────────────────────────────────────────────
  const queryColor = normalizeColor(query.color);
  if (queryColor && variant.colorway && queryColor === variant.colorway) {
    push(evidence, 'colorway', queryColor);
  }

  // ── Category ────────────────────────────────────────────────────────────
  const queryCategory = slugify(query.canonicalCategory);
  if (queryCategory && family.canonicalCategory && queryCategory === family.canonicalCategory) {
    push(evidence, 'category', queryCategory);
  }

  // ── Soft attributes ─────────────────────────────────────────────────────
  if (query.material && tokensContained(query.material, titles)) {
    push(evidence, 'material', normalizeText(query.material));
  }
  if (query.silhouette && tokensContained(query.silhouette, titles)) {
    push(evidence, 'silhouette', normalizeText(query.silhouette));
  }
  if (query.pattern && tokensContained(query.pattern, titles)) {
    push(evidence, 'pattern', normalizeText(query.pattern));
  }

  // ── Exact identifier ────────────────────────────────────────────────────
  // Re-checked against source capability here rather than trusted from the
  // variant, so that a future normalizer bug cannot smuggle a search-result id
  // into either identifier gate.
  const idBearingSources = variant.exactIdSources.filter(sourceCanCarryExactId);
  if (variant.exactProductId && idBearingSources.length >= 2) {
    push(evidence, 'corroborated_product_id', String(idBearingSources.length));
  } else if (variant.exactProductId && idBearingSources.length === 1) {
    push(evidence, 'exact_product_id', idBearingSources[0]);
  }

  // ── Cross-source agreement ──────────────────────────────────────────────
  if (variant.sources.length > 1) {
    push(evidence, 'cross_source_agreement', String(variant.sources.length));
  }

  return evidence;
}

/**
 * Assigns a tier from evidence.
 *
 * Read top-down: the first gate whose preconditions hold wins. Gates are
 * conjunctions of *kinds*, never of the score, which is what keeps the score
 * from being able to buy its way up a tier.
 */
export function assignTier(evidence: MatchEvidence[]): TierAssessment {
  const confidence = Math.min(
    1,
    evidence.reduce((sum, item) => sum + item.weight, 0),
  );

  const brandEstablished = has(evidence, 'visible_brand_text') || has(evidence, 'brand_guess');
  const brandProven = has(evidence, 'visible_brand_text');
  const model = has(evidence, 'model_token');
  const colorway = has(evidence, 'colorway');
  const category = has(evidence, 'category');
  // Decisive identity: authoritative on its own, or corroborated across two
  // independent id-bearing catalogues. Written as a named boolean so the rule
  // reads as the concept rather than as the workaround.
  const decisiveIdentity =
    has(evidence, 'authoritative_product_id') || has(evidence, 'corroborated_product_id');
  const exactId = decisiveIdentity || has(evidence, 'exact_product_id');

  // EXACT — decisive identity plus brand agreement. No inferential route
  // exists, and one retailer's own catalogue id is explicitly not enough.
  if (decisiveIdentity && brandEstablished) {
    return { tier: 'EXACT', confidence, evidence };
  }

  // LIKELY_EXACT — brand, model and colourway all agree.
  if (brandEstablished && model && colorway) {
    return { tier: 'LIKELY_EXACT', confidence, evidence };
  }

  // PRODUCT_FAMILY — brand and model agree; colour unknown or different.
  if (brandEstablished && model) {
    return { tier: 'PRODUCT_FAMILY', confidence, evidence };
  }

  // An identifier without brand agreement is still family-level knowledge: the
  // retailer says this is a specific catalogue entry, we just cannot confirm
  // the maker. It must not reach LIKELY_EXACT, which asserts the colourway.
  if (exactId && category) {
    return { tier: 'PRODUCT_FAMILY', confidence, evidence };
  }

  // SIMILAR — right category plus at least one further attribute agreement.
  const supportingAttributes = [colorway, has(evidence, 'material'), has(evidence, 'silhouette'), has(evidence, 'pattern')]
    .filter(Boolean).length;
  if (category && supportingAttributes >= 1) {
    return { tier: 'SIMILAR', confidence, evidence };
  }

  // A proven visible brand with the right category, but no model: the shopper
  // is looking at the right shelf. Still SIMILAR, never FAMILY — without a
  // model token there is no product to be a family of.
  if (brandProven && category) {
    return { tier: 'SIMILAR', confidence, evidence };
  }

  return { tier: 'NO_CONFIDENT_MATCH', confidence, evidence };
}

/**
 * Applies the exact-claims policy to an assessment.
 *
 * When exact claims are disabled, a match whose EVIDENCE satisfies the EXACT
 * gate is REPORTED as `LIKELY_EXACT`. The evidence array is left untouched, so
 * the downgrade is legible in the response and in telemetry: a reader can see
 * `corroborated_product_id` sitting under a `LIKELY_EXACT` tier and understand
 * exactly what happened. Stripping the evidence to "justify" the lower tier
 * would destroy the only record of why the flag matters.
 *
 * This is a separate function rather than a branch inside `assignTier` because
 * the gate and the policy answer different questions and must stay
 * independently testable — the rule has to be provably correct while the claim
 * is still switched off.
 */
export function applyExactClaimPolicy(
  assessment: TierAssessment,
  exactClaimsEnabled: boolean,
): TierAssessment {
  if (exactClaimsEnabled || assessment.tier !== 'EXACT') return assessment;
  return { ...assessment, tier: 'LIKELY_EXACT' };
}

/** Convenience: evidence collection, tier assignment, and claim policy. */
export function assessVariant(input: {
  query: ProductMatchQuery;
  family: DedupedFamily;
  variant: DedupedVariant;
  exactClaimsEnabled?: boolean;
}): TierAssessment {
  return applyExactClaimPolicy(
    assignTier(collectEvidence(input)),
    input.exactClaimsEnabled === true,
  );
}
