// style-outfit-generate — pure request/response validation.
//
// No Deno APIs, no network, no imports beyond the reasoning contract mirror.
// This module is unit-tested from the Node test harness via in-process TS
// transpilation, so every security-relevant rule below has direct coverage:
//
//   * Client candidate arrays (closetItems, candidateItems, candidateIds,
//     wardrobe, eligibleItems, …) are NEVER read. The candidate pool is built
//     exclusively from server-fetched rows.
//   * The anchor is a hint only; it must resolve inside the server pool.
//   * Provider output is validated against the same pool: invented, foreign,
//     deleted, and duplicate IDs are rejected; roles are forced back to the
//     server's own role assignment; outfit structure is enforced.
//   * Variation order is normalized to reliable → elevated → something_different.
//   * No commerce/retailer items can enter a validated outfit.

import {
  FASHION_REASONING_CONTRACT_VERSION,
  MAX_OUTFIT_ITEMS,
  MAX_OUTFIT_SUGGESTIONS,
  MIN_OUTFIT_ITEMS,
  OUTFIT_VARIATIONS,
  type GarmentRole,
  type OutfitVariation,
  inferGarmentRole,
  isOutfitDressCode,
  isOutfitOccasion,
  isOutfitSetting,
  isOutfitVariation,
  isStyleOutfitMode,
  satisfiesOutfitStructure,
  type StyleOutfitMode,
} from './reasoningContract.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX_CHARS = 280;
const REASON_MAX_CHARS = 240;

export type OwnedSourceType = 'saved_scan' | 'inspiration_item';

export type ItemRef = {
  sourceType: OwnedSourceType;
  sourceId: string;
};

export type ParsedStyleOutfitRequest = {
  mode: StyleOutfitMode;
  anchorItem: ItemRef | null;
  keepItems: ItemRef[];
  excludeItems: ItemRef[];
  event: {
    occasion: string | null;
    dressCode: string | null;
    setting: string | null;
    note: string | null;
  };
  maximumOutfits: number;
  contractVersion: string;
};

export type RequestParseResult =
  | { ok: true; request: ParsedStyleOutfitRequest }
  | { ok: false; error: string };

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function parseItemRef(raw: unknown): ItemRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const sourceType = record.sourceType;
  if (sourceType !== 'saved_scan' && sourceType !== 'inspiration_item') return null;
  if (!isValidUuid(record.sourceId)) return null;
  return { sourceType, sourceId: String(record.sourceId).trim().toLowerCase() };
}

function parseItemRefList(raw: unknown, limit: number): ItemRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: ItemRef[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, limit)) {
    const ref = parseItemRef(entry);
    if (!ref) continue;
    const key = `${ref.sourceType}:${ref.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * Parses and bounds the request body. Client-supplied candidate arrays are
 * intentionally not read: there is no code path from closetItems /
 * candidateItems / candidateIds / wardrobe / eligibleItems into the output.
 */
export function parseStyleOutfitRequest(body: unknown): RequestParseResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid request body' };
  }
  const record = body as Record<string, unknown>;

  if (!isStyleOutfitMode(record.mode)) {
    return { ok: false, error: 'Unsupported mode' };
  }
  const mode = record.mode;

  const contractVersion = cleanString(record.contractVersion, 8) ?? '';
  if (contractVersion !== FASHION_REASONING_CONTRACT_VERSION) {
    return { ok: false, error: 'Unsupported contract version' };
  }

  const anchorItem = parseItemRef(record.anchorItem);
  if ((mode === 'style_item' || mode === 'swap_item') && !anchorItem) {
    return { ok: false, error: 'An anchor item is required for this mode' };
  }

  // keepItems: current outfit context for swap/restyle modes (still validated
  // against the server pool later — a hint, never an authority).
  const keepItems = parseItemRefList(record.keepItems, MAX_OUTFIT_ITEMS);
  // excludeItems: explicit user corrections ("do not use this item"). Only
  // ever used to NARROW the server pool, never to expand it.
  const excludeItems = parseItemRefList(record.excludeItems, MAX_OUTFIT_ITEMS * 2);

  const eventRaw =
    record.event && typeof record.event === 'object' ? (record.event as Record<string, unknown>) : {};
  const occasion = isOutfitOccasion(eventRaw.occasion) ? (eventRaw.occasion as string) : null;
  const dressCode = isOutfitDressCode(eventRaw.dressCode) ? (eventRaw.dressCode as string) : null;
  const setting = isOutfitSetting(eventRaw.setting) ? (eventRaw.setting as string) : null;
  const note = cleanString(eventRaw.note, NOTE_MAX_CHARS);

  const rawMax = typeof record.maximumOutfits === 'number' ? record.maximumOutfits : MAX_OUTFIT_SUGGESTIONS;
  const maximumOutfits = Math.max(1, Math.min(Math.floor(rawMax) || MAX_OUTFIT_SUGGESTIONS, MAX_OUTFIT_SUGGESTIONS));

  return {
    ok: true,
    request: {
      mode,
      anchorItem,
      keepItems,
      excludeItems,
      event: { occasion, dressCode, setting, note },
      maximumOutfits,
      contractVersion,
    },
  };
}

// ── Server candidate pool ──────────────────────────────────────────────────────

export type CandidateItem = {
  sourceType: OwnedSourceType;
  sourceId: string;
  title: string;
  role: GarmentRole;
  category: string | null;
  subcategory: string | null;
  color: string | null;
  pattern: string | null;
  material: string | null;
  silhouette: string | null;
  brand: string | null;
  styleTags: string[];
};

export function candidateKey(ref: { sourceType: string; sourceId: string }): string {
  return `${ref.sourceType}:${String(ref.sourceId).toLowerCase()}`;
}

/**
 * Builds AI candidates from server-fetched saved_scans rows. Rows without a
 * category (no garment-role signal) are excluded. This is the ONLY path into
 * the candidate pool.
 */
export function buildCandidatesFromSavedScans(rows: Array<Record<string, unknown>>): CandidateItem[] {
  const candidates: CandidateItem[] = [];
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    if (row.deleted_at != null) continue;
    if (!isValidUuid(row.id)) continue;

    const analysis =
      row.analysis_result && typeof row.analysis_result === 'object'
        ? (row.analysis_result as Record<string, unknown>)
        : {};
    const meta =
      analysis.metadata && typeof analysis.metadata === 'object'
        ? (analysis.metadata as Record<string, unknown>)
        : {};

    const category = cleanString(meta.category, 60);
    if (!category) continue;

    const subcategory = cleanString(meta.subcategory, 60) ?? cleanString(meta.itemType, 60);
    candidates.push({
      sourceType: 'saved_scan',
      sourceId: String(row.id).toLowerCase(),
      title: cleanString(row.title, 80) ?? category,
      role: inferGarmentRole(category, subcategory),
      category,
      subcategory,
      color: cleanString(meta.color, 40) ?? cleanString(meta.color_palette, 40),
      pattern: cleanString(meta.pattern, 40),
      material: cleanString(meta.material_estimate, 40) ?? cleanString(meta.material, 40),
      silhouette: cleanString(meta.silhouette, 40),
      brand: cleanString(meta.brand, 40),
      styleTags: Array.isArray(meta.style_tags)
        ? (meta.style_tags as unknown[])
            .map((tag) => cleanString(tag, 24))
            .filter((tag): tag is string => !!tag)
            .slice(0, 8)
        : [],
    });
  }
  return candidates;
}

/**
 * Builds AI candidates from server-fetched inspiration_items rows (Phase 2).
 * An inspiration item is eligible ONLY when every condition holds:
 *   - active (deleted_at null) and a real UUID (ownership enforced by query)
 *   - a private image reference exists (storage_bucket + storage_path)
 *   - non-empty normalized category that is not 'unknown'
 *   - inferred role is not 'other', OR a valid explicit garment_role override
 *   - at least one of color/pattern/material/silhouette present
 * Ineligible rows never enter the pool and never get a model-invented role.
 */
export function buildCandidatesFromInspirationItems(
  rows: Array<Record<string, unknown>>,
): CandidateItem[] {
  const candidates: CandidateItem[] = [];
  const validRoles = ['top', 'bottom', 'dress', 'jumpsuit', 'outerwear', 'shoes', 'accessory', 'bag'];

  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    if (row.deleted_at != null) continue;
    if (!isValidUuid(row.id)) continue;

    const hasImage =
      typeof row.storage_bucket === 'string' && !!row.storage_bucket &&
      typeof row.storage_path === 'string' && !!row.storage_path;
    if (!hasImage) continue;

    const category = cleanString(row.category, 60);
    if (!category || category.toLowerCase() === 'unknown') continue;

    const color = cleanString(row.color, 40);
    const pattern = cleanString(row.pattern, 40);
    const material = cleanString(row.material, 40);
    const silhouette = cleanString(row.silhouette, 40);
    if (!color && !pattern && !material && !silhouette) continue;

    const inferredRole = inferGarmentRole(category, null);
    const override = cleanString(row.garment_role, 20);
    const role = inferredRole !== 'other'
      ? inferredRole
      : override && validRoles.includes(override)
        ? (override as GarmentRole)
        : null;
    if (!role) continue; // role 'other' without a valid explicit override

    candidates.push({
      sourceType: 'inspiration_item',
      sourceId: String(row.id).toLowerCase(),
      title: cleanString(row.note, 80) ?? category,
      role,
      category,
      subcategory: null,
      color,
      pattern,
      material,
      silhouette,
      brand: null,
      styleTags: [],
    });
  }
  return candidates;
}

export type PoolValidationResult =
  | { ok: true; pool: Map<string, CandidateItem>; anchor: CandidateItem | null }
  | { ok: false; error: string; reason: 'anchor_not_owned' | 'insufficient_closet' };

/**
 * Finalizes the exclusive candidate pool and resolves the anchor hint against
 * it. excludeItems only narrow the pool; the anchor is never excludable.
 */
export function finalizeCandidatePool(
  candidates: CandidateItem[],
  request: ParsedStyleOutfitRequest,
): PoolValidationResult {
  const pool = new Map<string, CandidateItem>();
  for (const candidate of candidates) {
    pool.set(candidateKey(candidate), candidate);
  }

  let anchor: CandidateItem | null = null;
  if (request.anchorItem) {
    anchor = pool.get(candidateKey(request.anchorItem)) ?? null;
    if (!anchor) {
      // The client-provided anchor does not exist in the server-authorized
      // pool (foreign, deleted, ineligible, or invented) — hard reject.
      return { ok: false, error: 'Anchor item is not available for styling', reason: 'anchor_not_owned' };
    }
  }

  for (const exclude of request.excludeItems) {
    const key = candidateKey(exclude);
    if (anchor && key === candidateKey(anchor)) continue;
    pool.delete(key);
  }

  // A credible outfit needs shoes plus a base garment at minimum.
  const roles = new Set(Array.from(pool.values()).map((item) => item.role));
  const hasBase = roles.has('dress') || roles.has('jumpsuit') || (roles.has('top') && roles.has('bottom'));
  if (pool.size < MIN_OUTFIT_ITEMS || !roles.has('shoes') || !hasBase) {
    return { ok: false, error: 'insufficient closet', reason: 'insufficient_closet' };
  }

  return { ok: true, pool, anchor };
}

// ── Provider output validation ────────────────────────────────────────────────

export type ValidatedOutfit = {
  variation: OutfitVariation;
  itemRefs: Array<{
    sourceType: OwnedSourceType;
    sourceId: string;
    role: GarmentRole;
    position: number;
  }>;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
};

/**
 * Validates raw provider JSON against the server candidate pool.
 * Outfits failing ANY rule are dropped; valid outfits are normalized into
 * canonical variation order. Fewer than the requested number of outfits is an
 * acceptable outcome — weak duplicates are never fabricated to fill slots.
 */
export function validateProviderOutfits(
  raw: unknown,
  pool: Map<string, CandidateItem>,
  anchor: CandidateItem | null,
  maximumOutfits: number,
): ValidatedOutfit[] {
  const rawOutfits: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).outfits)
      ? ((raw as Record<string, unknown>).outfits as unknown[])
      : [];

  const validated: ValidatedOutfit[] = [];
  const seenVariations = new Set<string>();
  const seenItemSets = new Set<string>();

  for (const entry of rawOutfits) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;

    const variation = isOutfitVariation(record.variation) ? (record.variation as OutfitVariation) : null;
    if (!variation || seenVariations.has(variation)) continue;

    const rawItems = Array.isArray(record.itemRefs)
      ? record.itemRefs
      : Array.isArray(record.items)
        ? record.items
        : null;
    if (!rawItems) continue;
    if (rawItems.length < MIN_OUTFIT_ITEMS || rawItems.length > MAX_OUTFIT_ITEMS) continue;

    const itemRefs: ValidatedOutfit['itemRefs'] = [];
    const seenKeys = new Set<string>();
    let valid = true;

    for (const rawItem of rawItems) {
      const ref = parseItemRef(rawItem);
      if (!ref) {
        valid = false; // malformed or non-owned source type (e.g. retailer product)
        break;
      }
      const key = candidateKey(ref);
      const candidate = pool.get(key);
      if (!candidate) {
        valid = false; // invented / foreign / deleted / excluded id
        break;
      }
      if (seenKeys.has(key)) {
        valid = false; // duplicate item inside one outfit
        break;
      }
      seenKeys.add(key);
      // Role authority is the SERVER's role inference, not provider output.
      itemRefs.push({
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        role: candidate.role,
        position: itemRefs.length,
      });
    }

    if (!valid || itemRefs.length < MIN_OUTFIT_ITEMS) continue;

    // Anchor must be present in every outfit when one exists.
    if (anchor && !seenKeys.has(candidateKey(anchor))) continue;

    // Outfit structure must be satisfied by server-assigned roles.
    if (!satisfiesOutfitStructure(itemRefs.map((item) => item.role))) continue;

    // Duplicate suggestion sets (same items in any order) are dropped.
    const setKey = Array.from(seenKeys).sort().join('|');
    if (seenItemSets.has(setKey)) continue;
    seenItemSets.add(setKey);

    const reason = cleanString(record.reason, REASON_MAX_CHARS) ?? 'A balanced combination from your closet.';
    // Never surface pseudo-precise scores: confidence is a coarse label only.
    const confidence =
      record.confidence === 'high' || record.confidence === 'medium' || record.confidence === 'low'
        ? (record.confidence as 'high' | 'medium' | 'low')
        : 'medium';

    seenVariations.add(variation);
    validated.push({ variation, itemRefs, reason, confidence });
  }

  // Canonical deterministic order; missing variations are simply omitted.
  const ordered = OUTFIT_VARIATIONS
    .map((variation) => validated.find((outfit) => outfit.variation === variation))
    .filter((outfit): outfit is ValidatedOutfit => !!outfit);

  return ordered.slice(0, Math.max(1, Math.min(maximumOutfits, MAX_OUTFIT_SUGGESTIONS)));
}
