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

/**
 * Category/subtype token -> layering role.
 *
 * DEFECT DEF-CON-002 (Build 34 / Concierge C2). This table previously held 26
 * entries and recognised only the four most generic footwear words. "loafers"
 * -- the flagship item of the Concierge train, and an ordinary Closet entry --
 * mapped to NO role, and so did oxfords, brogues, sandals, pumps, mules, flats,
 * trainers, chinos, leggings, tanks, polos, turtlenecks, vests, bombers,
 * parkas, trenches, pullovers, gowns, rompers and every non-"bag" accessory.
 *
 * A null role is not inert. It silently disabled the section 29 look
 * guardrails for those garments (an item with no role cannot be proven to
 * conflict with another), and it made role-based gap reasoning treat a Closet
 * full of loafers as having no footwear. The scoring module's whole
 * category/role dimension degrades the same way.
 *
 * This is a data extension of the EXISTING mapper, not a change to the
 * normalization contract: same function, same return type, same callers. It is
 * deliberately NOT an attempt to solve the section 24 limitations (silhouette,
 * formality, season, occasion), which stay out of scope for this train.
 *
 * Matching is substring-based on a lowercased token, so singular and plural
 * both hit ("loafer" and "loafers" alike) and compounds resolve ("penny
 * loafer", "chelsea boot"). Order matters only where one key is a substring of
 * another, and the loop below returns the first hit -- so the more specific
 * word must come first. `tshirt`/`t-shirt` precede `shirt` for that reason.
 */
const LAYERING_BY_CATEGORY: Record<string, string> = {
  // Outerwear
  coat: 'outer',
  jacket: 'outer',
  blazer: 'outer',
  trench: 'outer',
  parka: 'outer',
  anorak: 'outer',
  windbreaker: 'outer',
  bomber: 'outer',
  peacoat: 'outer',
  // Mid layers
  sweater: 'mid',
  hoodie: 'mid',
  cardigan: 'mid',
  sweatshirt: 'mid',
  pullover: 'mid',
  jumper: 'mid',
  fleece: 'mid',
  vest: 'mid',
  // Base layers. `tshirt` and `t-shirt` come before `shirt`, which is a
  // substring of neither but would otherwise be reached first for "t shirt".
  tshirt: 'base',
  't-shirt': 'base',
  turtleneck: 'base',
  shirt: 'base',
  blouse: 'base',
  top: 'base',
  tee: 'base',
  tank: 'base',
  camisole: 'base',
  polo: 'base',
  // One-piece
  dress: 'one_piece',
  gown: 'one_piece',
  jumpsuit: 'one_piece',
  romper: 'one_piece',
  overall: 'one_piece',
  // Bottoms
  pants: 'bottom',
  trousers: 'bottom',
  jeans: 'bottom',
  skirt: 'bottom',
  shorts: 'bottom',
  chino: 'bottom',
  legging: 'bottom',
  joggers: 'bottom',
  // Footwear
  shoes: 'shoe',
  sneakers: 'shoe',
  trainer: 'shoe',
  boots: 'shoe',
  heels: 'shoe',
  loafer: 'shoe',
  oxford: 'shoe',
  brogue: 'shoe',
  derby: 'shoe',
  sandal: 'shoe',
  pump: 'shoe',
  mule: 'shoe',
  espadrille: 'shoe',
  flats: 'shoe',
  // Accessories
  bag: 'accessory',
  purse: 'accessory',
  tote: 'accessory',
  clutch: 'accessory',
  backpack: 'accessory',
  belt: 'accessory',
  hat: 'accessory',
  // No bare `cap` token: it is a substring of "capris", which the bottoms block
  // above would otherwise lose to a later accessory match on some inputs. A
  // wrong role is worse than no role, because the guardrails act on it.
  beanie: 'accessory',
  scarf: 'accessory',
  glove: 'accessory',
  watch: 'accessory',
  necklace: 'accessory',
  bracelet: 'accessory',
  earring: 'accessory',
  sunglasses: 'accessory',
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
  const subcategory = asString(meta.subcategory) ?? asString(meta.itemType) ?? null;
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
    layeringRole: inferLayeringRole(category, subcategory),
    formality,
    seasons: asStringArray(meta.seasons ?? meta.season, 4),
    occasions: asStringArray(meta.occasions ?? meta.occasion, 4),
    styleAttributes: asStringArray(meta.styleAttributes ?? meta.style, 8),
    brand: asString(row.brand) ?? asString(meta.brand),
    confidence: asNumber(meta.confidence) ?? asNumber(meta.brandCertainty),
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
