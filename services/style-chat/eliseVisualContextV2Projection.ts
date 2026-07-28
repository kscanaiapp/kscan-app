// Canonical V2 → existing visual-context display fields (Phase 2B.3).
//
// WHY A PROJECTION AND NOT A REPLACEMENT: the header-gallery entry, its chip, its
// preview row and the legacy `activeContext.visualCollection` payload all read
// the Phase 2A.5 `EliseVisualContextInput` shape. Rewriting every one of those to
// read the V2 result would be a UI migration, not an identification migration, and
// this phase must not redesign StyleChat.
//
// SO: V2 remains the AUTHORITY and travels to the backend intact in
// `fashionContextV2`. These fields are a DISPLAY projection of the same identity —
// used for the chip title and the existing preview, never as the thing the model
// reasons from. When both are present the backend grounds on the canonical field
// and treats the descriptive collection as the display copy it always was.
//
// EVERY FIELD IS BUILT BY FILTERING, NEVER BY INTERPOLATION. `${a} ${b}` on
// nullable fields is what renders "null jacket" and "undefined sneakers"; the fix
// is to drop empties before joining.

import type { FashionIdentificationResultV2 } from '../../types/fashionIdentificationV2';
import { isRecord, str } from '../fashionIdentificationV2Core';

/** Descriptive projection matching the existing visual-context field set. */
export type ProjectedVisualContextFields = {
  title: string;
  summary: string | null;
  category: string | null;
  colors: string[] | null;
  materials: string[] | null;
  silhouette: string | null;
  styleAttributes: string[] | null;
  brand: string | null;
  confidence: number | null;
};

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = str(entry);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Projects a validated canonical result onto the display fields.
 *
 * Returns null when the result carries no category AND no subtype: with neither,
 * there is nothing to title the reference with, and a placeholder title on a
 * `ready` chip is precisely the defect IMG-007 recorded.
 */
export function projectV2ToVisualContextFields(
  result: FashionIdentificationResultV2 | null | undefined,
): ProjectedVisualContextFields | null {
  if (!result || !isRecord(result.item)) return null;
  const item = result.item;
  const category = str(item.category);
  const subtype = str(item.subtype);
  if (!category && !subtype) return null;

  const colorsRecord = isRecord(item.colors) ? item.colors : null;
  const primaryColor = colorsRecord ? str(colorsRecord.primary) : null;
  const colors = [
    ...(primaryColor ? [primaryColor] : []),
    ...list(colorsRecord?.secondary),
  ].filter((value, index, all) => all.indexOf(value) === index);

  const attributes = isRecord(item.attributes) ? item.attributes : null;
  // Style attributes gather the descriptive-but-not-identity fields the existing
  // UI already showed in one row. Pattern and fit belong here; category, subtype
  // and brand do not, because they have their own fields.
  const styleAttributes = [
    ...list(item.pattern),
    ...(attributes
      ? [
        str(attributes.fit),
        str(attributes.length),
        str(attributes.sleeve),
        str(attributes.neckline),
        str(attributes.collar),
        str(attributes.closure),
      ].filter((value): value is string => typeof value === 'string')
      : []),
    ...list(attributes?.distinctive),
  ].filter((value, index, all) => all.indexOf(value) === index);

  const materials = list(item.material);
  const silhouettes = list(item.silhouette);
  const brand = isRecord(item.brand) ? str(item.brand.value) : null;
  const compatibility = isRecord(result.compatibility) ? result.compatibility : null;
  const globalConfidence = compatibility
    && typeof compatibility.globalConfidence === 'number'
    && Number.isFinite(compatibility.globalConfidence)
    ? Math.max(0, Math.min(1, compatibility.globalConfidence))
    : null;

  // Title parts are filtered, then joined. Subtype absorbs category when present
  // so a "Puffer Jacket" does not become "Puffer Jacket Outerwear".
  const titleParts = [primaryColor, subtype ?? category].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const baseTitle = titleParts.join(' ');
  const title = brand && baseTitle
    ? `${baseTitle} · ${brand}`
    : baseTitle || brand || (category ?? subtype) as string;

  return {
    title: title.slice(0, 160),
    // Summary is composed from observed evidence only. No provider prose, and no
    // sentence asserting an attribute that was not confirmed.
    summary: buildSummary({ category, subtype, brand, primaryColor, materials, status: result.status }),
    category: category ?? subtype,
    colors: colors.length > 0 ? colors : null,
    materials: materials.length > 0 ? materials : null,
    silhouette: silhouettes.length > 0 ? silhouettes[0] : null,
    styleAttributes: styleAttributes.length > 0 ? styleAttributes : null,
    brand,
    // Absent confidence stays null. Coercing it to 0 would state active
    // no-confidence where the truth is "not reported".
    confidence: globalConfidence,
  };
}

/**
 * A short honest summary line.
 *
 * A `partial` status says so explicitly, so a half-identified garment is never
 * displayed with the same certainty as a fully identified one.
 */
function buildSummary(input: {
  category: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  materials: string[];
  status: string;
}): string | null {
  const descriptor = [input.primaryColor, input.subtype ?? input.category]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  if (!descriptor) return null;

  const clauses: string[] = [descriptor];
  if (input.materials.length > 0) clauses.push(`in ${input.materials.join(', ')}`);
  if (input.brand) clauses.push(`from ${input.brand}`);
  const sentence = clauses.join(' ');
  return input.status === 'partial'
    ? `${sentence}. Some details were not confirmed.`
    : sentence;
}
