/**
 * E-4 fashion feature normalization.
 * Unknown values remain unknown — never invent properties.
 */

import type {
  EliseActorRelationship,
  EliseWardrobeCandidate,
  EliseWardrobeSourceType,
} from './eliseAdviceTypes.ts';

const COLOR_FAMILIES: Record<string, string> = {
  black: 'neutral',
  white: 'neutral',
  cream: 'neutral',
  beige: 'neutral',
  gray: 'neutral',
  grey: 'neutral',
  navy: 'cool',
  blue: 'cool',
  teal: 'cool',
  green: 'cool',
  red: 'warm',
  orange: 'warm',
  yellow: 'warm',
  pink: 'warm',
  burgundy: 'warm',
  brown: 'earth',
  tan: 'earth',
  olive: 'earth',
  purple: 'cool',
};

const LAYERING_BY_CATEGORY: Record<string, string> = {
  coat: 'outer',
  jacket: 'outer',
  blazer: 'outer',
  sweater: 'mid',
  hoodie: 'mid',
  cardigan: 'mid',
  shirt: 'base',
  blouse: 'base',
  top: 'base',
  tee: 'base',
  tshirt: 'base',
  dress: 'one_piece',
  jumpsuit: 'one_piece',
  pants: 'bottom',
  trousers: 'bottom',
  jeans: 'bottom',
  skirt: 'bottom',
  shorts: 'bottom',
  shoes: 'shoe',
  sneakers: 'shoe',
  boots: 'shoe',
  heels: 'shoe',
  bag: 'accessory',
  belt: 'accessory',
  hat: 'accessory',
  scarf: 'accessory',
};

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}

function asStringArray(value: unknown, max = 8): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => asString(v))
      .filter((v): v is string => Boolean(v))
      .slice(0, max);
  }
  const single = asString(value);
  return single ? [single] : [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function lower(value: string | null): string {
  return value ? value.toLowerCase() : '';
}

export function inferColorFamilies(colors: string[]): string[] {
  const families = new Set<string>();
  for (const color of colors) {
    const key = color.toLowerCase();
    for (const [token, family] of Object.entries(COLOR_FAMILIES)) {
      if (key.includes(token)) families.add(family);
    }
  }
  return [...families].slice(0, 6);
}

export function inferLayeringRole(category: string | null, subcategory: string | null): string | null {
  const keys = [lower(category), lower(subcategory)].filter(Boolean);
  for (const key of keys) {
    for (const [token, role] of Object.entries(LAYERING_BY_CATEGORY)) {
      if (key.includes(token)) return role;
    }
  }
  return null;
}

export function inferProportionRole(silhouette: string | null, fit: string | null): string | null {
  const blob = `${lower(silhouette)} ${lower(fit)}`;
  if (!blob.trim()) return null;
  if (/\boversized|voluminous|wide|relaxed\b/.test(blob)) return 'volume';
  if (/\bfitted|slim|tailored|structured\b/.test(blob)) return 'streamlined';
  if (/\bcropped|crop\b/.test(blob)) return 'cropped';
  if (/\blongline|long\b/.test(blob)) return 'longline';
  return null;
}

function snapshotMeta(row: Record<string, unknown>): Record<string, unknown> {
  const payload = row.snapshot_payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const meta = (payload as Record<string, unknown>).metadata;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      return meta as Record<string, unknown>;
    }
    return payload as Record<string, unknown>;
  }
  const fashion = row.fashion;
  if (fashion && typeof fashion === 'object' && !Array.isArray(fashion)) {
    return fashion as Record<string, unknown>;
  }
  return {};
}

export function normalizeWardrobeCandidate(input: {
  candidateId: string;
  sourceType: EliseWardrobeSourceType;
  actorRelationship: EliseActorRelationship;
  row: Record<string, unknown>;
  canonicalResourceIds?: EliseWardrobeCandidate['canonicalResourceIds'];
}): EliseWardrobeCandidate {
  const row = input.row;
  const meta = snapshotMeta(row);
  const category =
    asString(row.category) ??
    asString(meta.category) ??
    asString(meta.itemType) ??
    asString(meta.item_type);
  const subcategory =
    asString(meta.subcategory) ??
    asString(meta.subtype) ??
    asString(meta.itemType) ??
    asString(meta.item_type) ??
    null;
  const colors = [
    ...asStringArray(row.color),
    ...asStringArray(meta.color),
    ...asStringArray(meta.colors),
  ].slice(0, 8);
  const materials = [
    ...asStringArray(row.material),
    ...asStringArray(meta.material),
    ...asStringArray(meta.materials),
  ].slice(0, 6);
  const silhouette = asString(meta.silhouette) ?? asString(row.silhouette);
  const fit = asString(meta.fit) ?? asString(row.fit);
  const formality = asString(meta.formality) ?? asString(meta.dressCode) ?? null;
  const categoryRole = inferLayeringRole(category, null);
  const subcategoryRole = inferLayeringRole(subcategory, null);
  const metadataWarnings: string[] = [];
  if (categoryRole && subcategoryRole && categoryRole !== subcategoryRole) {
    metadataWarnings.push('contradictory_category_metadata');
  }

  return {
    candidateId: input.candidateId.slice(0, 80),
    sourceType: input.sourceType,
    actorRelationship: input.actorRelationship,
    title:
      asString(row.title) ??
      asString(row.name) ??
      asString(meta.title) ??
      asString(meta.description)?.slice(0, 80) ??
      null,
    category,
    subcategory,
    colors,
    colorFamilies: inferColorFamilies(colors),
    materials,
    textures: asStringArray(meta.texture ?? meta.textures, 4),
    patterns: asStringArray(meta.pattern ?? meta.patterns, 4),
    silhouette,
    fit,
    proportionRole: inferProportionRole(silhouette, fit),
    layeringRole: metadataWarnings.length
      ? null
      : categoryRole ?? subcategoryRole,
    formality,
    seasons: asStringArray(meta.seasons ?? meta.season, 4),
    occasions: asStringArray(meta.occasions ?? meta.occasion, 4),
    styleAttributes: asStringArray(meta.styleAttributes ?? meta.style, 8),
    brand: asString(row.brand) ?? asString(meta.brand),
    confidence: asNumber(meta.confidence) ?? asNumber(meta.brandCertainty),
    metadataWarnings,
    canonicalResourceIds: input.canonicalResourceIds ?? {},
  };
}

export function ownershipLanguageLabel(relationship: EliseActorRelationship): string {
  switch (relationship) {
    case 'owned':
      return 'You already have';
    case 'saved':
      return "You've saved";
    case 'scanned':
      return 'The item you scanned';
    case 'shared':
      return 'Shared with you';
    case 'discovered':
      return 'One available option is';
    case 'unverified':
    case 'unknown':
    default:
      return 'Based on the available details';
  }
}
