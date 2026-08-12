/**
 * Brand evidence tiering and gating (Phase 7.2 §7–§11, §17).
 *
 * Decides whether the image actually contains evidence that establishes WHO MADE
 * the identified item, as opposed to evidence that it merely LOOKS LIKE a brand.
 *
 * THE GOVERNING ASYMMETRY: brand precision matters more than brand answer rate.
 * A false "Nike" or "Gucci" propagates straight into Product Match and corrupts
 * every downstream query built from it, while an honest unknown costs only a
 * blank field. So every rule here is biased toward abstention, and filling more
 * brand fields is explicitly NOT the success measure.
 *
 * NO NEW PROVIDER CALL, NO OCR SERVICE. The tier a scan lands in is read from
 * fields the existing multimodal primary call already returns; this module only
 * classifies and gates them.
 *
 * NOT A BRAND CATALOG. There is deliberately no list of brand names and no
 * brand-by-style rule table (§24). Tiering is about the KIND of evidence
 * present, never about which brand was guessed — a lookup table would encode
 * exactly the "resembles that brand's style" inference §7 forbids.
 */

/**
 * Evidence strength, ordered weakest → strongest.
 *
 *   none        no brand evidence of any kind
 *   style_only  Tier C — resemblance only. NEVER establishes brand.
 *   distinctive Tier B — genuinely distinctive product evidence.
 *   direct      Tier A — a readable mark that names the brand.
 */
export const BRAND_EVIDENCE_LEVELS = ['none', 'style_only', 'distinctive', 'direct'] as const;
export type BrandEvidenceLevel = typeof BRAND_EVIDENCE_LEVELS[number];

/** What was actually seen. Free of brand names by construction. */
export const BRAND_EVIDENCE_TYPES = [
  'wordmark',
  'logo',
  'label',
  'monogram',
  'hardware',
  'model_detail',
  'distinctive_construction',
  'none',
] as const;
export type BrandEvidenceType = typeof BRAND_EVIDENCE_TYPES[number];

/** Evidence types that constitute a direct, brand-naming mark (Tier A). */
const DIRECT_TYPES: ReadonlySet<BrandEvidenceType> = new Set([
  'wordmark',
  'logo',
  'label',
  'monogram',
]);

/** Evidence types that are distinctive product evidence (Tier B). */
const DISTINCTIVE_TYPES: ReadonlySet<BrandEvidenceType> = new Set([
  'hardware',
  'model_detail',
  'distinctive_construction',
]);

export function isBrandEvidenceLevel(value: unknown): value is BrandEvidenceLevel {
  return typeof value === 'string' && (BRAND_EVIDENCE_LEVELS as readonly string[]).includes(value);
}

export function isBrandEvidenceType(value: unknown): value is BrandEvidenceType {
  return typeof value === 'string' && (BRAND_EVIDENCE_TYPES as readonly string[]).includes(value);
}

/**
 * Text that is present on garments but says nothing about who made them.
 *
 * Care, size, composition and regulatory text is the single most common source
 * of a false brand read: it is high-contrast, legible, and sits exactly where a
 * brand label would. Matching here is on the SHAPE of the text, not on any brand
 * list.
 */
const NON_BRAND_TEXT_PATTERNS: readonly RegExp[] = [
  // Fibre composition: "100% COTTON", "80% WOOL 20% NYLON".
  /\b\d{1,3}\s*%/,
  /\b(cotton|polyester|wool|nylon|elastane|spandex|viscose|rayon|linen|acrylic|cashmere|silk|leather|modal|lyocell)\b/i,
  // Care instructions.
  /\b(machine\s*wash|hand\s*wash|do\s*not\s*(bleach|tumble|iron|dry)|tumble\s*dry|dry\s*clean|iron\s*low|wash\s*cold|line\s*dry)\b/i,
  // Sizing.
  /^\s*(xxs|xs|s|m|l|xl|xxl|xxxl|\d{1,2}(\.\d)?|\d{2}\s*[\/x]\s*\d{2}|eu\s*\d{2}|uk\s*\d{1,2}|us\s*\d{1,2})\s*$/i,
  /\b(size|talla|taille|größe|regular\s*fit|slim\s*fit)\b/i,
  // Origin / regulatory.
  /\b(made\s*in|fabriqué|hecho\s*en|rn\s*\d+|ca\s*\d+|oeko-?tex)\b/i,
];

/**
 * Whether visible text is care/size/composition rather than a brand mark.
 * "100% COTTON" must never become a brand.
 */
export function isNonBrandText(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return NON_BRAND_TEXT_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Whether visible text is too fragmentary to name a brand.
 *
 * Rejects truncation marks and stubs — "NI...", "AD—", "GUC". Completing these
 * is the classic hallucination: the model has three letters and a prior, and the
 * prior wins. A stub is not evidence, so it is not allowed to become one.
 *
 * The 3-character floor is a deliberate trade: it rejects some genuinely short
 * real marks in exchange for rejecting every stub. Given the precision
 * asymmetry, that is the correct direction to be wrong in.
 */
export function isPartialBrandText(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Explicit truncation marks.
  if (/(\.{2,}|…|[-–—]\s*$)/.test(trimmed)) return true;
  // Strip decoration and measure what is actually legible.
  const letters = trimmed.replace(/[^A-Za-z0-9'&]/g, '');
  if (letters.length < 3) return true;
  return false;
}

export type BrandEvidenceInput = {
  /** The brand the model proposed, if any. */
  brandGuess: string | null;
  /** Text the model reports as visibly readable on the item. */
  visibleBrandText: string | null;
  /** Whether a logo was reported on the item. */
  logoDetected: boolean;
  /** Model-reported evidence level, when the prompt produced one. */
  reportedLevel: BrandEvidenceLevel | null;
  /** Model-reported evidence type, when the prompt produced one. */
  reportedType: BrandEvidenceType | null;
  /**
   * Whether the reported evidence was attributed to the identified item rather
   * than to background, packaging, another garment, a screen or a watermark.
   * NULL means the model did not say — which is NOT treated as confirmation.
   */
  evidenceOnItem: boolean | null;
};

export type BrandEvidenceDecision = {
  level: BrandEvidenceLevel;
  type: BrandEvidenceType;
  /** Whether a brand value may be asserted at all. */
  brandEstablished: boolean;
  /** Stable machine reasons, for telemetry and tests. */
  reasons: string[];
};

/**
 * The single brand gating decision.
 *
 * Order matters: disqualifiers run BEFORE any promotion, so a piece of evidence
 * that is care text, a stub, or attached to something other than the identified
 * item can never reach the tier logic at all.
 */
export function decideBrandEvidence(input: BrandEvidenceInput): BrandEvidenceDecision {
  const reasons: string[] = [];

  const brand = typeof input.brandGuess === 'string' ? input.brandGuess.trim() : '';
  const rawText = typeof input.visibleBrandText === 'string' ? input.visibleBrandText.trim() : '';

  // ── Disqualifiers ─────────────────────────────────────────────────────────
  // Evidence belonging to something else is not evidence about this item. A
  // logo on background signage, a shopping bag, a screen, or a second garment
  // is a real mark of a real brand — just not of the thing being identified.
  const attributionRejected = input.evidenceOnItem === false;
  if (attributionRejected) reasons.push('evidence_not_on_item');

  let usableText = rawText;
  if (usableText && isNonBrandText(usableText)) {
    reasons.push('text_is_care_or_size');
    usableText = '';
  }
  if (usableText && isPartialBrandText(usableText)) {
    reasons.push('text_partial_or_illegible');
    usableText = '';
  }

  // ── Tier resolution ───────────────────────────────────────────────────────
  // The model's self-reported level is accepted only as far as surviving
  // evidence supports it. A claim of `direct` with no readable text, no logo and
  // no label is a claim without a referent.
  const hasDirectArtifact = (!attributionRejected) &&
    (usableText.length > 0 || (input.logoDetected === true && !attributionRejected));

  const reportedType = input.reportedType && isBrandEvidenceType(input.reportedType)
    ? input.reportedType
    : null;

  let level: BrandEvidenceLevel = 'none';
  let type: BrandEvidenceType = 'none';

  if (hasDirectArtifact) {
    level = 'direct';
    type = reportedType && DIRECT_TYPES.has(reportedType)
      ? reportedType
      : (usableText.length > 0 ? 'wordmark' : 'logo');
    reasons.push('direct_mark_present');
  } else if (
    !attributionRejected &&
    reportedType &&
    DISTINCTIVE_TYPES.has(reportedType) &&
    input.reportedLevel === 'distinctive'
  ) {
    // Tier B requires the model to BOTH name a distinctive evidence type AND
    // rate it distinctive. Either alone is too easy to reach from styling.
    level = 'distinctive';
    type = reportedType;
    reasons.push('distinctive_product_evidence');
  } else if (brand) {
    // A brand was proposed with nothing behind it. That is Tier C by
    // definition — resemblance — regardless of how it was labelled.
    level = 'style_only';
    type = 'none';
    reasons.push('style_resemblance_only');
  } else {
    reasons.push('no_brand_evidence');
  }

  // ── Establishment ─────────────────────────────────────────────────────────
  // Tier A establishes brand. Tier B may support it. Tier C never does, and
  // that is the rule this whole module exists to enforce.
  const brandEstablished = brand.length > 0 &&
    (level === 'direct' || level === 'distinctive');

  if (brand.length > 0 && !brandEstablished) reasons.push('brand_suppressed');

  return { level, type, brandEstablished, reasons };
}

/**
 * Maps an evidence decision onto the EXISTING V2 brand provenance vocabulary.
 *
 * Deliberately no new provenance value: `FASHION_IDENTIFICATION_BRAND_PROVENANCES`
 * is mirrored in three places (JSON schema, backend, client) and held together by
 * a parity test, so widening it for an internal tier would be a three-way
 * contract change this build has no need to make.
 *
 * `catalog_corroboration` and `commerce_corroboration` are never produced here:
 * commerce runs downstream of identification and must not feed back into it.
 */
export function brandProvenanceFromEvidence(
  decision: BrandEvidenceDecision,
): 'visible_text' | 'logo_shape' | 'visual' | 'unknown' {
  if (!decision.brandEstablished) return 'unknown';
  if (decision.type === 'wordmark' || decision.type === 'label') return 'visible_text';
  if (decision.type === 'logo' || decision.type === 'monogram') return 'logo_shape';
  return 'visual';
}

// ── Pipeline application ─────────────────────────────────────────────────────

export type BrandGateResult = {
  identification: Record<string, unknown>;
  decision: BrandEvidenceDecision;
  /** True when a proposed brand was removed for lack of qualifying evidence. */
  brandSuppressed: boolean;
};

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Applies the brand evidence tier gate to a sanitized identification.
 *
 * COMPOSES WITH, RATHER THAN REPLACES, the existing brand suppression in
 * `scannerQualityGate`. Both only ever REMOVE a brand, never add one, so running
 * both is safe in either order and strictly more conservative than running
 * either alone. Rewriting the older gate to delegate here would have changed the
 * behavior its own suite pins, for no precision gain.
 *
 * Returns a NEW identification object; the input is not mutated.
 */
export function applyBrandEvidenceGate(
  identificationIn: Record<string, unknown> | null | undefined,
): BrandGateResult {
  const identification: Record<string, unknown> = identificationIn &&
      typeof identificationIn === 'object'
    ? { ...identificationIn }
    : {};

  const reportedLevel = identification.brand_evidence_level;
  const reportedType = identification.brand_evidence_type;
  const onItemRaw = identification.brand_evidence_on_item;

  const decision = decideBrandEvidence({
    brandGuess: readString(identification, 'brand_guess'),
    visibleBrandText: readString(identification, 'visible_brand_text'),
    logoDetected: identification.logo_detected === true,
    reportedLevel: isBrandEvidenceLevel(reportedLevel) ? reportedLevel : null,
    reportedType: isBrandEvidenceType(reportedType) ? reportedType : null,
    // Absent attestation stays NULL rather than defaulting to true. Assuming
    // the evidence was on the item is the assumption that lets a background
    // logo through, which is the exact failure §17 is about.
    evidenceOnItem: typeof onItemRaw === 'boolean' ? onItemRaw : null,
  });

  const hadBrand = readString(identification, 'brand_guess') !== null;
  const brandSuppressed = hadBrand && !decision.brandEstablished;

  if (brandSuppressed) {
    identification.brand_guess = null;
  }

  // Text that failed attribution or turned out to be care/size/partial text is
  // cleared too. Leaving it behind would let a downstream consumer treat
  // "100% COTTON" or a background mark as brand evidence all over again —
  // scanCommerceRouter reads visible_brand_text directly.
  const textDisqualified = decision.reasons.includes('text_is_care_or_size') ||
    decision.reasons.includes('text_partial_or_illegible') ||
    decision.reasons.includes('evidence_not_on_item');
  if (textDisqualified) {
    identification.visible_brand_text = null;
  }
  if (decision.reasons.includes('evidence_not_on_item')) {
    identification.logo_detected = false;
  }

  // Record the resolved tier, so telemetry and the V2 projection read a decided
  // value rather than the model's unvalidated self-report.
  identification.brand_evidence_level = decision.level;
  identification.brand_evidence_type = decision.type;

  return { identification, decision, brandSuppressed };
}
