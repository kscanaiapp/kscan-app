// Normalizers and queries for the unified owned-item styling contract.
//
// Sources normalized here:
//   - saved_scans rows (cloud)            → normalizeSavedScanRow
//   - local SavedScanModel objects        → normalizeLocalSavedScan
//   - inspiration_items rows/models       → normalizeInspirationItem
//
// Rules enforced by this module (see types/ownedClosetItem.ts):
//   - Local-only ids are never presented as remote UUIDs.
//   - No remote id is ever invented; remote backing comes only from the
//     existing saved-scan cloud-sync path (savedScansCloud.saveScanToCloud).
//   - No image binaries are uploaded or duplicated here.

import { supabase } from './supabaseClient';
import {
  saveScanToCloud,
  type SavedScanModel,
  type SavedScanRow,
} from './savedScansCloud';
import {
  OWNED_ITEM_CONTRACT_VERSION,
  type OwnedClosetItem,
  ownedItemKey,
} from '../types/ownedClosetItem';
import type { InspirationItem } from '../types/styleObjects';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);
}

export function isServerVerifiableUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

type SavedScanMeta = {
  category: string | null;
  subcategory: string | null;
  color: string | null;
  pattern: string | null;
  material: string | null;
  silhouette: string | null;
  fit: string | null;
  brand: string | null;
  styleTags: string[];
};

function extractSavedScanMeta(analysis: unknown): SavedScanMeta {
  const analysisObject =
    analysis && typeof analysis === 'object' ? (analysis as Record<string, unknown>) : {};
  const meta =
    analysisObject.metadata && typeof analysisObject.metadata === 'object'
      ? (analysisObject.metadata as Record<string, unknown>)
      : {};

  return {
    category: cleanText(meta.category),
    subcategory: cleanText(meta.subcategory) || cleanText(meta.itemType),
    color: cleanText(meta.color) || cleanText(meta.color_palette),
    pattern: cleanText(meta.pattern),
    material: cleanText(meta.material_estimate) || cleanText(meta.material),
    silhouette: cleanText(meta.silhouette),
    fit: cleanText(meta.fit),
    brand: cleanText(meta.brand),
    styleTags: cleanTags(meta.style_tags),
  };
}

/**
 * AI eligibility: the item must be remote-backed (server-verifiable) and carry
 * at least a category so garment-role reasoning is possible.
 */
function computeAiEligibility(input: {
  remoteBacked: boolean;
  unavailable: boolean;
  category: string | null;
}): boolean {
  return input.remoteBacked && !input.unavailable && !!input.category;
}

// ── saved_scans (cloud row) ────────────────────────────────────────────────────

export function normalizeSavedScanRow(row: SavedScanRow): OwnedClosetItem {
  const meta = extractSavedScanMeta(row.analysis_result);
  const unavailable = row.deleted_at != null;
  const remoteBacked = isServerVerifiableUuid(row.id);
  const category = meta.category;
  // Remote-media-backed (Phase 2): only a 'ready' status with a full private
  // storage reference exposes the storage fields for signed resolution.
  const mediaReady =
    row.media_status === 'ready' && !!cleanText(row.storage_bucket) && !!cleanText(row.storage_path);

  return {
    sourceType: 'saved_scan',
    sourceId: remoteBacked ? row.id : null,
    localId: cleanText(row.local_id),
    title: cleanText(row.title) || category || 'Saved scan',
    imageUri: cleanText(row.thumbnail_uri) || cleanText(row.image_uri),
    storageBucket: mediaReady ? cleanText(row.storage_bucket) : null,
    storagePath: mediaReady ? cleanText(row.storage_path) : null,
    mediaStatus: row.media_status ?? null,
    category,
    subcategory: meta.subcategory,
    color: meta.color,
    pattern: meta.pattern,
    material: meta.material,
    silhouette: meta.silhouette,
    fit: meta.fit,
    brand: meta.brand,
    styleTags: meta.styleTags,
    normalizedAttributes: {},
    sourceMetadata: {
      savedAt: cleanText(row.saved_at),
      scanType: cleanText(row.scan_type),
    },
    unavailable,
    remoteBacked,
    aiEligible: computeAiEligibility({ remoteBacked, unavailable, category }),
    contractVersion: OWNED_ITEM_CONTRACT_VERSION,
  };
}

// ── local saved scan (device manifest model) ──────────────────────────────────

export function normalizeLocalSavedScan(scan: SavedScanModel): OwnedClosetItem {
  const attributes = scan.attributes ?? ({} as SavedScanModel['attributes']);
  const remoteBacked = isServerVerifiableUuid(scan.cloudId);
  const unavailable = scan.deletedAt != null;
  const category = cleanText(attributes.category);

  return {
    sourceType: 'saved_scan',
    // Local ids are NOT server-verifiable; only a synced cloudId becomes sourceId.
    sourceId: remoteBacked ? (scan.cloudId as string) : null,
    localId: cleanText(scan.id),
    title: category || 'Saved scan',
    imageUri: cleanText(scan.thumbnailUri) || cleanText(scan.imageUri),
    storageBucket: null,
    storagePath: null,
    category,
    subcategory: null,
    color: cleanText(attributes.color_palette),
    pattern: null,
    material: cleanText(attributes.material_estimate),
    silhouette: cleanText(attributes.silhouette),
    fit: null,
    brand: null,
    styleTags: cleanTags(attributes.style_tags),
    normalizedAttributes: {},
    sourceMetadata: {
      savedAt: cleanText(scan.savedAt) || cleanText(scan.createdAt),
      scanType: cleanText(scan.source),
    },
    unavailable,
    remoteBacked,
    aiEligible: computeAiEligibility({ remoteBacked, unavailable, category }),
    contractVersion: OWNED_ITEM_CONTRACT_VERSION,
  };
}

// ── inspiration_items ─────────────────────────────────────────────────────────

export function normalizeInspirationItem(item: InspirationItem): OwnedClosetItem {
  const unavailable = item.deletedAt != null;
  const remoteBacked = isServerVerifiableUuid(item.id);
  // Phase 2 additive styling metadata (null until explicit enrichment).
  const category = cleanText(item.category);
  const color = cleanText(item.color);
  const pattern = cleanText(item.pattern);
  const material = cleanText(item.material);
  const silhouette = cleanText(item.silhouette);
  const hasAttribute = !!(color || pattern || material || silhouette);

  return {
    sourceType: 'inspiration_item',
    sourceId: remoteBacked ? item.id : null,
    localId: null,
    title: cleanText(item.note) || category || 'Inspiration',
    imageUri: cleanText(item.imageUrl),
    storageBucket: cleanText(item.storageBucket),
    storagePath: cleanText(item.storagePath),
    mediaStatus: 'ready',
    category,
    subcategory: null,
    color,
    pattern,
    material,
    silhouette,
    fit: null,
    brand: null,
    styleTags: [],
    normalizedAttributes: item.garmentRole ? { garmentRole: item.garmentRole } : {},
    sourceMetadata: {
      savedAt: cleanText(item.createdAt),
      note: cleanText(item.note),
    },
    unavailable,
    remoteBacked,
    // AI-eligible only once explicitly enriched: category + ≥1 attribute
    // (mirrors the server-side inspiration eligibility gate).
    aiEligible: remoteBacked && !unavailable && !!category && hasAttribute,
    contractVersion: OWNED_ITEM_CONTRACT_VERSION,
  };
}

// ── Combined listing for pickers ──────────────────────────────────────────────

/**
 * Lists the current user's styleable owned items for selection UIs.
 * Local scans are merged in by localId so devices without cloud sync still see
 * their closet; when a cloud row exists for the same local scan the cloud row
 * (with its stable UUID) wins.
 */
export async function listOwnedClosetItems(input?: {
  localScans?: SavedScanModel[];
}): Promise<OwnedClosetItem[]> {
  const items: OwnedClosetItem[] = [];
  const seen = new Set<string>();
  const seenLocalIds = new Set<string>();

  const [scanResult, inspirationResult] = await Promise.all([
    supabase
      .from('saved_scans')
      .select('*')
      .is('deleted_at', null)
      .order('saved_at', { ascending: false }),
    supabase
      .from('inspiration_items')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
  ]);

  for (const row of (scanResult.data ?? []) as SavedScanRow[]) {
    const item = normalizeSavedScanRow(row);
    const key = ownedItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.localId) seenLocalIds.add(item.localId);
    items.push(item);
  }

  for (const row of (inspirationResult.data ?? []) as unknown[]) {
    const raw = row as Record<string, unknown>;
    const item = normalizeInspirationItem({
      id: String(raw.id ?? ''),
      userId: String(raw.user_id ?? ''),
      storageBucket: String(raw.storage_bucket ?? ''),
      storagePath: String(raw.storage_path ?? ''),
      source: 'upload',
      note: (raw.note as string | null) ?? null,
      imageUrl: null,
      createdAt: String(raw.created_at ?? ''),
      deletedAt: (raw.deleted_at as string | null) ?? null,
      category: (raw.category as string | null) ?? null,
      color: (raw.color as string | null) ?? null,
      pattern: (raw.pattern as string | null) ?? null,
      material: (raw.material as string | null) ?? null,
      silhouette: (raw.silhouette as string | null) ?? null,
      garmentRole: (raw.garment_role as string | null) ?? null,
    });
    const key = ownedItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  for (const scan of input?.localScans ?? []) {
    const item = normalizeLocalSavedScan(scan);
    if (item.localId && seenLocalIds.has(item.localId)) continue;
    const key = ownedItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  return items;
}

// ── Remote backing before server persistence ─────────────────────────────────

export class OwnedItemSyncError extends Error {
  constructor(message = 'This item could not be synced to your account yet. Your selection is unchanged — please try again.') {
    super(message);
    this.name = 'OwnedItemSyncError';
  }
}

/**
 * Ensures a stable remote row exists for an owned item before it is used in a
 * remotely persisted Look, AI generation, or Dressing Room sharing.
 *
 * - Already remote-backed items are returned unchanged.
 * - Local-only saved scans go through the existing saved-scan cloud-sync path
 *   (no duplicate binaries; metadata upsert by user_id + local_id).
 * - On failure the caller's draft/selection state is preserved: this function
 *   throws OwnedItemSyncError and never mutates the input.
 * - No UUID is ever invented.
 */
export async function ensureRemoteBackedOwnedItem(
  item: OwnedClosetItem,
  input?: { localScan?: SavedScanModel },
): Promise<OwnedClosetItem> {
  if (item.remoteBacked && item.sourceId) return item;

  if (item.sourceType !== 'saved_scan' || !item.localId) {
    throw new OwnedItemSyncError();
  }

  const localScan = input?.localScan;
  if (localScan && localScan.id === item.localId) {
    const result = await saveScanToCloud(localScan);
    if (!result.ok) throw new OwnedItemSyncError();
  }

  // Look up the synced row by local_id (RLS scopes to the current user).
  const { data, error } = await supabase
    .from('saved_scans')
    .select('*')
    .eq('local_id', item.localId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error || !data || !isServerVerifiableUuid((data as SavedScanRow).id)) {
    throw new OwnedItemSyncError();
  }

  return normalizeSavedScanRow(data as SavedScanRow);
}
