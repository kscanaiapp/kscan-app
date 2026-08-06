// Null-safe display projection for fashion-identification-v2 (Phase 2B.2).
//
// WHY ONE MODULE INSTEAD OF GUARDS SPREAD ACROSS COMPONENTS: nearly every field
// in the V2 result is legitimately nullable — brand, category, subtype, colours,
// material, every confidence. The existing Scanner UI was written against the
// legacy display shape, where those fields are always strings (empty when
// absent). Rather than auditing every `.toUpperCase()`, template literal and
// concatenation in the result and Recent Scans surfaces for null-safety, the
// nullable contract is converted to the string-shaped contract exactly once,
// here, and the components keep the guarantee they were written against.
//
// THE TWO FAILURE MODES THIS PREVENTS:
//   `item.brand.value.toUpperCase()`      → crash on a null brand
//   `${brand} ${category}`                → renders the text "null Jacket"
//
// A missing value therefore becomes an omitted field or an empty string, never
// the literal strings "null"/"undefined", and never a fabricated zero.

import type { FashionIdentificationResultV2 } from '../types/fashionIdentificationV2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** The only string coercion in this module. Nullable in, safe string out. */
export function safeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  // Guards against a provider or a prior serialization step that stringified a
  // null into the text "null" — rendering that is indistinguishable to a user
  // from a genuine brand named null, and it is never what we mean.
  if (trimmed === 'null' || trimmed === 'undefined') return '';
  return trimmed;
}

/** Non-empty, de-duplicated strings, order preserved. */
export function safeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = safeText(entry);
    if (text) seen.add(text);
  }
  return [...seen];
}

/**
 * Joins label parts, dropping every empty one.
 *
 * This is the pattern that keeps "null Jacket" and " Jacket" off the screen: a
 * template literal would interpolate the absent brand, and a plain join would
 * leave its separator behind.
 */
export function joinLabel(parts: ReadonlyArray<string | null | undefined>, separator = ' '): string {
  return parts
    .map((part) => safeText(part))
    .filter((part): part is string => part.length > 0)
    .join(separator);
}

/**
 * A confidence that is genuinely absent stays absent.
 *
 * Coercing an unknown confidence to 0 would be a claim the model never made —
 * and 0 reads as "certainly not", the strongest possible statement, rather than
 * "unknown".
 */
export function safeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

export type ScannerV2Display = {
  /** Display title. Empty only when the result carries no identity at all. */
  title: string;
  /** Long-form result line for the existing analysis surface. */
  result: string;
  category: string;
  /** Phase 7. Empty string, matching every other field here, when absent. */
  clothingType: string;
  subtype: string;
  brand: string;
  primaryColor: string;
  secondaryColors: string[];
  colorLabel: string;
  material: string[];
  silhouette: string[];
  pattern: string[];
  visibleAttributes: string[];
  distinctiveAttributes: string[];
  /** Absent when unknown. Never fabricated to 0. */
  confidence?: number;
  resolutionLevel: string;
  status: string;
};

/**
 * Projects a VALIDATED V2 result into safe display strings.
 *
 * Callers must validate first (`validateScannerV2Response`); this function is
 * defensive anyway, because being handed a shape it did not expect must degrade
 * to empty text rather than throw inside a React render.
 */
export function buildScannerV2Display(
  result: FashionIdentificationResultV2 | null | undefined,
): ScannerV2Display {
  const empty: ScannerV2Display = {
    title: '',
    result: '',
    category: '',
    clothingType: '',
    subtype: '',
    brand: '',
    primaryColor: '',
    secondaryColors: [],
    colorLabel: '',
    material: [],
    silhouette: [],
    pattern: [],
    visibleAttributes: [],
    distinctiveAttributes: [],
    resolutionLevel: '',
    status: '',
  };
  if (!isRecord(result)) return empty;

  const EMPTY: Record<string, unknown> = {};
  const item: Record<string, unknown> = isRecord(result.item) ? result.item : EMPTY;
  const brandBlock: Record<string, unknown> = isRecord(item.brand) ? item.brand : EMPTY;
  const colors: Record<string, unknown> = isRecord(item.colors) ? item.colors : EMPTY;
  const attributes: Record<string, unknown> = isRecord(item.attributes) ? item.attributes : EMPTY;
  const confidenceBlock: Record<string, unknown> = isRecord(result.confidence)
    ? result.confidence
    : EMPTY;
  const exactProduct = isRecord(result.exactProduct) ? result.exactProduct : null;

  const category = safeText(item.category);
  const clothingType = safeText(item.clothingType);
  const subtype = safeText(item.subtype);
  const brand = safeText(brandBlock.value);
  const primaryColor = safeText(colors.primary);
  const secondaryColors = safeList(colors.secondary).filter((c) => c !== primaryColor);

  // A model name is a stronger identity than a subtype, so it wins when the
  // backend actually resolved one. It is still only used when present.
  const model = exactProduct ? safeText(exactProduct.model) : '';

  // Brand may be null while category and subtype are perfectly valid. Dropping
  // the whole title in that case would hide a real result.
  const title = joinLabel([brand, model || subtype || category]);
  const result_ = joinLabel([primaryColor, brand, model || subtype || category]);

  const confidence = safeConfidence(confidenceBlock.category)
    ?? safeConfidence((result as { compatibility?: unknown }).compatibility &&
      isRecord(result.compatibility) ? result.compatibility.globalConfidence : undefined);

  return {
    title,
    result: result_,
    category,
    clothingType,
    subtype,
    brand,
    primaryColor,
    secondaryColors,
    colorLabel: joinLabel([primaryColor, ...secondaryColors], ', '),
    material: safeList(item.material),
    silhouette: safeList(item.silhouette),
    pattern: safeList(item.pattern),
    visibleAttributes: safeList(attributes.visible),
    distinctiveAttributes: safeList(attributes.distinctive),
    ...(confidence !== undefined ? { confidence } : {}),
    resolutionLevel: safeText(result.resolutionLevel),
    status: safeText(result.status),
  };
}

export type ScannerV2StatusKind =
  | 'completed'
  | 'partial'
  | 'insufficient_visual_evidence'
  | 'non_fashion'
  | 'needs_selection'
  | 'technical_failure'
  | 'unknown';

/**
 * Maps a V2 status onto the Scanner's existing UX branches.
 *
 * `insufficient_visual_evidence` and `technical_failure` stay DISTINCT: the
 * first means "we saw the photo and could not identify it" and belongs on the
 * rescan path; the second means "something broke" and belongs on the technical
 * retry path. Collapsing them would tell a user to retake a perfectly good
 * photo because a provider timed out.
 */
export function classifyScannerV2Status(status: unknown): ScannerV2StatusKind {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'partial':
      return 'partial';
    case 'insufficient_visual_evidence':
      return 'insufficient_visual_evidence';
    case 'non_fashion':
      return 'non_fashion';
    case 'multiple_items_need_selection':
      return 'needs_selection';
    case 'technical_failure':
      return 'technical_failure';
    default:
      return 'unknown';
  }
}

/** Commerce is meaningful only for a chosen, identity-bearing item. */
export function allowsCommerceDisplay(status: unknown): boolean {
  const kind = classifyScannerV2Status(status);
  return kind === 'completed' || kind === 'partial';
}

/**
 * A detection candidate is a preliminary observation, not a completed identity.
 * Treating one as a result would present an unconfirmed guess as an answer.
 */
export function isCompletedIdentity(status: unknown): boolean {
  const kind = classifyScannerV2Status(status);
  return kind === 'completed' || kind === 'partial';
}
