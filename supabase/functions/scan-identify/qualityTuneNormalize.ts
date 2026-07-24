/**
 * Deterministic fashion taxonomy normalization + generic-label recovery.
 * Preserves response shape. No new client-visible fields.
 */

import {
  normalizeCategory,
  normalizeColor,
  normalizeMaterial,
  normalizeSilhouette,
  normalizeStringArray,
} from '../_shared/scanHelpers.ts';

export const GENERIC_LABELS = new Set([
  'fashion item',
  'clothing',
  'apparel',
  'unknown',
  'item',
  'clothes',
  'garment',
  'fashion',
  'product',
  'n/a',
  'na',
  'none',
  'null',
]);

/** Display subtypes keyed by canonical category (catalog-aligned). */
const SUBTYPE_CANONICAL: Record<string, string> = {
  'sportcoat': 'Sport Coat',
  'sport coat': 'Sport Coat',
  'sport jacket': 'Sport Coat',
  'sports coat': 'Sport Coat',
  'sports jacket': 'Sport Coat',
  'tee shirt': 'T-Shirt',
  't shirt': 'T-Shirt',
  't-shirt': 'T-Shirt',
  'tshirt': 'T-Shirt',
  'tee': 'T-Shirt',
  'hand bag': 'Handbag',
  'handbag': 'Handbag',
  'moto jacket': 'Moto Jacket',
  'motorcycle jacket': 'Moto Jacket',
  'biker jacket': 'Moto Jacket',
  'wide leg trousers': 'Wide-Leg Trousers',
  'wide-leg trousers': 'Wide-Leg Trousers',
  'wide leg pants': 'Wide-Leg Trousers',
  'pleated skirt': 'Pleated Skirt',
  'ankle boots': 'Ankle Boots',
  'ankle boot': 'Ankle Boots',
  'knit sweater': 'Knit Sweater',
  'crewneck sweater': 'Knit Sweater',
};

const COLOR_DISPLAY: Record<string, string> = {
  'dark blue': 'Navy',
  'navy blue': 'Navy',
  'off white': 'Off-White',
  'off-white': 'Off-White',
  'offwhite': 'Off-White',
  'charcoal grey': 'Charcoal',
  'charcoal gray': 'Charcoal',
  'dark grey': 'Charcoal',
  'dark gray': 'Charcoal',
};

/** Subtype → category when subtype is reliable. */
const SUBTYPE_TO_CATEGORY: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(moto|biker|bomber|puffer|parka|trench|peacoat|raincoat|windbreaker|anorak|overcoat)\b/i, category: 'outerwear' },
  { pattern: /\b(blazer|sport\s?coat|suit\s?jacket)\b/i, category: 'blazer' },
  { pattern: /\b(dress|gown|frock|sundress)\b/i, category: 'dress' },
  { pattern: /\b(skirt|pleated\s+skirt|mini\s+skirt|midi\s+skirt|maxi\s+skirt)\b/i, category: 'dress' },
  { pattern: /\b(trouser|pants|jeans|chino|jogger|legging|short|culotte|wide-?leg)\b/i, category: 'pants' },
  { pattern: /\b(sneaker|trainer|loafer|heel|sandal|boot|pump|flat)\b/i, category: 'footwear' },
  { pattern: /\b(handbag|tote|clutch|backpack|satchel|crossbody|purse)\b/i, category: 'bag' },
  { pattern: /\b(sweater|hoodie|tee|t-?shirt|blouse|polo|cardigan|tank|shirt)\b/i, category: 'top' },
  { pattern: /\b(belt|scarf|hat|cap|sunglass|watch|jewelry|earring|necklace)\b/i, category: 'accessory' },
];

/** Category → incompatible subtype patterns (force subtype clear or remap). */
const CATEGORY_SUBTYPE_CONFLICTS: Array<{ category: string; badSubtype: RegExp; resolveSubtype?: string }> = [
  { category: 'dress', badSubtype: /\b(trouser|pants|jeans|sneaker|boot|blazer|jacket)\b/i },
  { category: 'pants', badSubtype: /\b(skirt|dress|gown|sneaker|boot|blazer|jacket|handbag)\b/i },
  { category: 'footwear', badSubtype: /\b(jacket|blazer|dress|trouser|pants|handbag|skirt)\b/i },
  { category: 'bag', badSubtype: /\b(jacket|blazer|dress|trouser|pants|sneaker|boot)\b/i },
  { category: 'blazer', badSubtype: /\b(sneaker|boot|handbag|skirt|dress|trouser)\b/i },
  { category: 'outerwear', badSubtype: /\b(sneaker|boot|handbag|skirt|dress|trouser|wide-?leg)\b/i },
  { category: 'top', badSubtype: /\b(sneaker|boot|handbag|skirt|trouser|pants|jacket|coat)\b/i },
];

const SPECULATIVE_BRAND_BLOCKLIST = new Set([
  'gucci', 'prada', 'louis vuitton', 'lv', 'chanel', 'dior', 'hermes', 'hermès',
  'balenciaga', 'versace', 'fendi', 'givenchy', 'ysl', 'saint laurent', 'burberry',
  'miumiu', 'miu miu', 'celine', 'céline', 'bottega', 'bottega veneta', 'luxury',
  'designer', 'unknown brand',
]);

export type NormalizationCorrection = {
  ruleId: string;
  field: string;
};

export type QualityNormalizeResult = {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  correctionCount: number;
  ruleIds: string[];
  genericLabelOccurrence: number;
  invalidPairResolved: number;
};

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function titleCaseWords(s: string): string {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 2 && w.toUpperCase() === w ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

function isGenericLabel(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const t = collapseSpaces(value).toLowerCase();
  if (!t) return true;
  return GENERIC_LABELS.has(t);
}

function canonicalizeSubtypeDisplay(raw: string): { value: string; ruleId?: string } {
  const key = collapseSpaces(raw).toLowerCase();
  if (SUBTYPE_CANONICAL[key]) {
    return { value: SUBTYPE_CANONICAL[key], ruleId: 'subtype_synonym' };
  }
  // Soft punctuation / whitespace cleanup
  const cleaned = collapseSpaces(raw.replace(/[_/]+/g, ' ').replace(/\s+/g, ' '));
  if (cleaned !== raw) return { value: titleCaseWords(cleaned), ruleId: 'subtype_whitespace' };
  return { value: cleaned };
}

function canonicalizeColorDisplay(raw: string): { value: string; ruleId?: string } {
  const key = collapseSpaces(raw).toLowerCase();
  if (COLOR_DISPLAY[key]) return { value: COLOR_DISPLAY[key], ruleId: 'color_synonym' };
  const canon = normalizeColor(raw);
  if (canon === 'navy') return { value: 'Navy', ruleId: key === 'navy' ? undefined : 'color_synonym' };
  if (canon === 'white/cream' && /off/.test(key)) return { value: 'Off-White', ruleId: 'color_synonym' };
  return { value: collapseSpaces(raw) };
}

function categoryFromSubtype(subtype: string): string | null {
  for (const row of SUBTYPE_TO_CATEGORY) {
    if (row.pattern.test(subtype)) return row.category;
  }
  return null;
}

function dedupeDescriptors(arr: unknown): { values: string[]; corrected: boolean } {
  if (!Array.isArray(arr)) return { values: [], corrected: Array.isArray(arr) === false && arr != null };
  const out: string[] = [];
  const seen = new Set<string>();
  let corrected = false;
  for (const entry of arr) {
    if (typeof entry !== 'string') {
      corrected = true;
      continue;
    }
    const t = collapseSpaces(entry);
    if (!t) {
      corrected = true;
      continue;
    }
    const key = t.toLowerCase();
    if (seen.has(key)) {
      corrected = true;
      continue;
    }
    seen.add(key);
    out.push(t);
  }
  if (!Array.isArray(arr)) corrected = true;
  return { values: out, corrected };
}

function suppressSpeculativeBrand(
  identification: Record<string, unknown>,
  corrections: NormalizationCorrection[],
): void {
  const logo = identification.logo_detected === true;
  const visible = typeof identification.visible_brand_text === 'string'
    ? collapseSpaces(identification.visible_brand_text)
    : '';
  const hasEvidence = logo || visible.length > 0;

  const guess = typeof identification.brand_guess === 'string'
    ? collapseSpaces(identification.brand_guess)
    : '';
  if (!guess) {
    if (identification.brand_guess !== null && identification.brand_guess !== undefined && identification.brand_guess !== '') {
      identification.brand_guess = null;
      corrections.push({ ruleId: 'brand_empty_normalize', field: 'brand_guess' });
    }
    return;
  }
  if (!hasEvidence) {
    identification.brand_guess = null;
    corrections.push({ ruleId: 'brand_no_evidence', field: 'brand_guess' });
    return;
  }
  if (SPECULATIVE_BRAND_BLOCKLIST.has(guess.toLowerCase()) &&
      visible.toLowerCase() !== guess.toLowerCase()) {
    identification.brand_guess = null;
    corrections.push({ ruleId: 'brand_speculative_block', field: 'brand_guess' });
  }
}

/**
 * Apply deterministic taxonomy normalization + generic recovery to identification
 * (and optionally attributes). Response keys are unchanged.
 */
export function applyQualityTaxonomyTune(
  identificationIn: Record<string, unknown> | null | undefined,
  attributesIn?: Record<string, unknown> | null,
): QualityNormalizeResult {
  const corrections: NormalizationCorrection[] = [];
  let genericLabelOccurrence = 0;
  let invalidPairResolved = 0;

  const identification: Record<string, unknown> = identificationIn && typeof identificationIn === 'object'
    ? { ...identificationIn }
    : {};
  const attributes: Record<string, unknown> | undefined = attributesIn && typeof attributesIn === 'object'
    ? { ...attributesIn }
    : undefined;

  const mark = (ruleId: string, field: string) => corrections.push({ ruleId, field });

  // Empty / malformed string fields → empty string cleanup
  for (const field of [
    'item_type', 'subtype', 'primary_color', 'pattern', 'material_estimate',
    'silhouette', 'fit', 'length', 'sleeve_length', 'neckline_or_lapel', 'closure',
    'visual_observation',
  ]) {
    const v = identification[field];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') {
      identification[field] = '';
      mark('malformed_string', field);
      continue;
    }
    const cleaned = collapseSpaces(v);
    if (cleaned !== v) {
      identification[field] = cleaned;
      mark('whitespace_normalize', field);
    }
  }

  // Array cleanup
  for (const field of ['secondary_colors', 'distinctive_features', 'style_tags', 'occasion_tags', 'search_queries', 'styling_suggestions']) {
    const before = identification[field];
    const { values, corrected } = dedupeDescriptors(before);
    if (corrected || JSON.stringify(before) !== JSON.stringify(values)) {
      identification[field] = values;
      if (corrected) mark('array_dedupe_clean', field);
    }
  }

  // Color synonym display
  if (typeof identification.primary_color === 'string' && identification.primary_color) {
    const c = canonicalizeColorDisplay(identification.primary_color);
    if (c.ruleId && c.value !== identification.primary_color) {
      identification.primary_color = c.value;
      mark(c.ruleId, 'primary_color');
    }
  }

  // Subtype synonym display
  if (typeof identification.subtype === 'string' && identification.subtype && !isGenericLabel(identification.subtype)) {
    const s = canonicalizeSubtypeDisplay(identification.subtype);
    if (s.ruleId && s.value !== identification.subtype) {
      identification.subtype = s.value;
      mark(s.ruleId, 'subtype');
    }
  }

  // Material soft cleanup via existing normalizer vocabulary
  if (typeof identification.material_estimate === 'string' && identification.material_estimate) {
    const m = normalizeMaterial(identification.material_estimate);
    if (m === 'faux leather' && /lamb|genuine|real/i.test(identification.material_estimate as string) &&
        /faux|vegan|pu|synthetic/i.test(identification.material_estimate as string) === false) {
      // Keep model text but do not invent "lamb leather" upgrades — strip luxury animal claims without evidence words
    }
    // Remove unsupported luxury material claims when speculative
    const mat = identification.material_estimate as string;
    if (/\b(lamb\s+leather|cashmere\s+blend|designer)\b/i.test(mat) && !/\b(visible|label|tag)\b/i.test(mat)) {
      if (/faux|vegan|pu|synthetic/i.test(mat)) {
        identification.material_estimate = 'faux leather';
        mark('material_speculative_strip', 'material_estimate');
      } else if (/\blamb\s+leather\b/i.test(mat)) {
        identification.material_estimate = 'leather';
        mark('material_speculative_strip', 'material_estimate');
      }
    }
  }

  // Generic label detection on primary fields
  const itemTypeGeneric = isGenericLabel(identification.item_type);
  const subtypeGeneric = isGenericLabel(identification.subtype);
  if (itemTypeGeneric) genericLabelOccurrence += 1;
  if (subtypeGeneric && itemTypeGeneric) {
    // counted once for primary label collapse
  }

  // Recover category from subtype
  if (itemTypeGeneric && typeof identification.subtype === 'string' && !isGenericLabel(identification.subtype)) {
    const derived = categoryFromSubtype(identification.subtype as string);
    if (derived) {
      identification.item_type = derived;
      mark('recover_category_from_subtype', 'item_type');
    }
  }

  // Recover subtype from attributes.itemType when identification subtype generic
  if (isGenericLabel(identification.subtype) && attributes) {
    const attrItem = typeof attributes.itemType === 'string' ? attributes.itemType : '';
    if (attrItem && !isGenericLabel(attrItem)) {
      const s = canonicalizeSubtypeDisplay(attrItem);
      identification.subtype = s.value;
      mark('recover_subtype_from_attributes', 'subtype');
    }
  }

  // Recover item_type from attributes.category
  if (isGenericLabel(identification.item_type) && attributes) {
    const cat = typeof attributes.category === 'string' ? attributes.category : '';
    const canon = normalizeCategory(cat);
    if (canon && canon !== 'NON_FASHION' && !isGenericLabel(canon)) {
      identification.item_type = canon;
      mark('recover_category_from_attributes', 'item_type');
    }
  }

  // Category / subtype conflict resolution (prefer category when structured, else subtype→category)
  let canonCat = normalizeCategory(
    typeof identification.item_type === 'string' ? identification.item_type : '',
  );
  // Local skirt synonym (catalog uses dress family; avoid bare "skirt" passthrough conflicts)
  if (
    typeof identification.item_type === 'string' &&
    /^\s*skirts?\s*$/i.test(identification.item_type)
  ) {
    identification.item_type = 'dress';
    canonCat = 'dress';
    mark('skirt_category_alias', 'item_type');
  }
  const subtypeStr = typeof identification.subtype === 'string' ? identification.subtype : '';
  if (canonCat && subtypeStr && !isGenericLabel(subtypeStr)) {
    const subtypeCat = categoryFromSubtype(subtypeStr);
    if (subtypeCat && subtypeCat !== canonCat && !isGenericLabel(canonCat)) {
      // Conflicting structured pair — prefer subtype-derived category when it is concrete.
      identification.item_type = subtypeCat;
      mark('resolve_category_subtype_conflict', 'item_type');
      invalidPairResolved += 1;
      canonCat = subtypeCat;
    }
    for (const rule of CATEGORY_SUBTYPE_CONFLICTS) {
      if (rule.category === canonCat && rule.badSubtype.test(subtypeStr)) {
        const fromSubtype = categoryFromSubtype(subtypeStr);
        if (fromSubtype && fromSubtype !== canonCat) {
          identification.item_type = fromSubtype;
          mark('resolve_category_subtype_conflict', 'item_type');
          invalidPairResolved += 1;
        } else {
          identification.subtype = canonCat === 'dress' ? 'Dress' :
            canonCat === 'pants' ? 'Trousers' :
            canonCat === 'footwear' ? 'Shoes' :
            canonCat === 'bag' ? 'Bag' :
            canonCat === 'blazer' ? 'Blazer' :
            canonCat === 'outerwear' ? 'Jacket' :
            canonCat === 'top' ? 'Top' : '';
          mark('clear_incompatible_subtype', 'subtype');
          invalidPairResolved += 1;
        }
        break;
      }
    }
  }

  // If still generic item_type but canonical category from normalizeCategory of subtype works
  if (isGenericLabel(identification.item_type) && subtypeStr) {
    const fromSub = normalizeCategory(subtypeStr);
    if (fromSub && fromSub !== 'NON_FASHION' && !isGenericLabel(fromSub)) {
      identification.item_type = fromSub;
      mark('recover_category_normalize_subtype', 'item_type');
    }
  }

  suppressSpeculativeBrand(identification, corrections);

  // Sync attributes legacy fields without renaming
  if (attributes) {
    if (typeof identification.item_type === 'string' && identification.item_type && !isGenericLabel(identification.item_type)) {
      if (isGenericLabel(attributes.category) || attributes.category !== identification.item_type) {
        const prev = attributes.category;
        attributes.category = identification.item_type;
        if (prev !== attributes.category) mark('sync_attributes_category', 'attributes.category');
      }
    }
    if (typeof identification.subtype === 'string' && identification.subtype && !isGenericLabel(identification.subtype)) {
      if (isGenericLabel(attributes.itemType) || !attributes.itemType) {
        attributes.itemType = identification.subtype;
        mark('sync_attributes_itemType', 'attributes.itemType');
      }
    }
    if (typeof identification.primary_color === 'string' && identification.primary_color) {
      const palette = Array.isArray(attributes.colorPalette) ? [...attributes.colorPalette] : [];
      if (palette.length === 0 || (typeof palette[0] === 'string' && isGenericLabel(palette[0]))) {
        attributes.colorPalette = [identification.primary_color];
        mark('sync_attributes_color', 'attributes.colorPalette');
      }
    }
    // Clean attribute arrays
    for (const field of ['styleTags', 'colorPalette']) {
      const { values, corrected } = dedupeDescriptors(attributes[field]);
      if (corrected) {
        attributes[field] = values;
        mark('attributes_array_clean', field);
      }
    }
  }

  // Final generic count on primary label (item_type)
  const finalGeneric = isGenericLabel(identification.item_type) ? 1 : 0;

  return {
    identification,
    attributes,
    correctionCount: corrections.length,
    ruleIds: [...new Set(corrections.map((c) => c.ruleId))],
    genericLabelOccurrence: Math.max(genericLabelOccurrence, finalGeneric),
    invalidPairResolved,
  };
}

export function isGenericFashionLabel(value: unknown): boolean {
  return isGenericLabel(value);
}

/** Expose normalizers for commerce query builders (reuse catalog taxonomy). */
export {
  normalizeCategory,
  normalizeColor,
  normalizeMaterial,
  normalizeSilhouette,
  normalizeStringArray,
};
