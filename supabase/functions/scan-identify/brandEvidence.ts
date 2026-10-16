/** Scanner-only interpretation of observed brand evidence. Never maps a letter to a brand. */
export type ScannerBrandEvidence = {
  brand: string | null;
  verified: boolean;
  source: 'wordmark' | 'logo' | 'none';
  confidence: 'high' | 'medium' | 'low' | null;
};

export const SCANNER_BRAND_PROMPT = `
Inspect the selected fashion item for visible wordmarks, tags, monograms and distinctive logos before concluding it is unbranded.
Keep observations separate from hypotheses: visible_brand_text contains only legible brand wording, never a decorative letter.
For an actually visible logo, provide logo_detected, logo_brand (the brand the logo identifies), logo_description (a short description of its observed shape and placement), and logo_confidence (low, medium, high).
A single sufficiently distinctive, confidently classified logo can identify a brand without readable text. A bare letter or generic patch cannot.
For example, a clearly classified New Balance slanted side-panel N on a sneaker can support New Balance; an arbitrary decorative N, unrelated logo, or unclear mark cannot. Do not map every N to New Balance.
Set brand_guess to the supported brand when the evidence is strong. Otherwise leave it absent rather than inventing one.
Logo evidence establishes brand only, not an exact product, model number, SKU or colorway. Do not invent a model from brand recognition.
Retain the item's specific subtype, primary and secondary colors, visible texture, material appearance, silhouette, closure, sole and construction details. Analyze only the chosen garment; do not borrow logos or details from other objects.`;

/** Only bounded states are logged; no image, wordmark, model guess, query or URL. */
export function summarizeScannerBrandEvidence(id: Record<string, unknown>) {
  const evidence = resolveScannerBrandEvidence(id);
  return {
    brandEvidenceSource: evidence.source,
    brandVerified: evidence.verified,
    logoDetected: id.logo_detected === true,
    hasBrandHypothesis: typeof id.brand_guess === 'string' && id.brand_guess.trim().length > 0,
    hasExactHypothesis: typeof id.exact_item_hypothesis === 'string' && id.exact_item_hypothesis.trim().length > 0,
  };
}

function brandName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) return null;
  if (/^(unknown|none|null|undefined|n\/a|logo|monogram|brand|unbranded)$/i.test(name)) return null;
  if (/\b(possibly|maybe|probably|inspired|style|looking|designer|luxury)\b/i.test(name)) return null;
  return name;
}

export function resolveScannerBrandEvidence(id: Record<string, unknown>): ScannerBrandEvidence {
  const wordmark = brandName(id.visible_brand_text);
  if (wordmark) return { brand: wordmark, verified: true, source: 'wordmark', confidence: 'high' };

  // These fields describe one classified visual signal, not a requirement for
  // two independent signals. A generic logo boolean is not brand attribution.
  const logoBrand = brandName(id.logo_brand);
  const logoConfidence = typeof id.logo_confidence === 'string' ? id.logo_confidence.trim().toLowerCase() : '';
  if (id.logo_detected === true && logoBrand && logoConfidence === 'high') {
    return { brand: logoBrand, verified: true, source: 'logo', confidence: 'high' };
  }
  return { brand: null, verified: false, source: 'none', confidence: null };
}

/** Project into the existing shared identity contract without changing its authority. */
export function projectScannerBrandIdentity(id: Record<string, unknown>): Record<string, unknown> {
  const evidence = resolveScannerBrandEvidence(id);
  return {
    ...id,
    brand_guess: evidence.verified ? evidence.brand : null,
    ...(id.visible_brand_text && evidence.source !== 'wordmark' ? { visible_brand_text: null } : {}),
  };
}

export function shouldUseScannerBrandEvidence(mode: string, entryPath: unknown, source?: unknown): boolean {
  return mode === 'image' && ![entryPath, source].some(value =>
    typeof value === 'string' && /^elise(?:_|$)/i.test(value)
  );
}

/** Keep non-Scanner callers on their existing optional model fields. */
export function scopeScannerBrandSchema<T extends { properties: { identification: { properties: object } } }>(
  schema: T, scannerEnabled: boolean, commerceIdentityEnabled: boolean,
): T {
  if (scannerEnabled) return schema;
  const properties = { ...schema.properties.identification.properties } as Record<string, unknown>;
  const scannerFields = ['logo_brand', 'logo_description', 'logo_confidence'];
  if (!commerceIdentityEnabled) scannerFields.push('visible_brand_text', 'logo_detected', 'brand_guess');
  for (const key of scannerFields) delete properties[key];
  return {
    ...schema,
    properties: { ...schema.properties, identification: { ...schema.properties.identification, properties } },
  };
}
