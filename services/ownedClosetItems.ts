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
//     existing saved-scan cloud upsert (savedScansCloud —
//     upsertSavedScanRowForAttachment for the explicit attachment saga).
//   - No image binaries are uploaded or duplicated here.

import { supabase } from './supabaseClient';
import {
  upsertSavedScanRowForAttachment,
  type SavedScanModel,
  type SavedScanRow,
} from './savedScansCloud';
import {
  ABSENT_ITEM_METADATA_PROVENANCE,
  OWNED_ITEM_CONTRACT_VERSION,
  type OwnedClosetItem,
  type OwnedItemMetadataProvenance,
  ownedItemKey,
} from '../types/ownedClosetItem';
import type { InspirationItem } from '../types/styleObjects';
import {
  resolveCanonicalFashionMetadata,
  type CanonicalFashionMetadata,
} from './canonicalFashionMetadata';
import {
  sanitizeIdentificationSnapshot,
  sanitizeIdentificationSnapshotV2,
  type PersistedIdentificationSnapshotV1,
  type PersistedIdentificationSnapshotV2,
} from './identificationSnapshot';

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

/**
 * Read a stored `analysis_result` blob into canonical metadata.
 *
 * BEFORE Closet V2 this read only `analysis_result.metadata` — the six-field
 * legacy projection of `SavedScanModel.attributes` (category, silhouette,
 * color_palette, material_estimate, style_tags, confidence_score). It also
 * looked for `subcategory`, `pattern`, `fit` and `brand`, none of which that
 * writer emits, so those four resolved to null on every row ever written.
 *
 * The durable `identificationSnapshot` on the same blob has always carried
 * them. It is now the authority, with the legacy projection as the per-field
 * fallback so legacy and snapshot-less rows are unaffected.
 */
function resolveSavedScanMetadata(analysis: unknown): CanonicalFashionMetadata {
  const analysisObject =
    analysis && typeof analysis === 'object' ? (analysis as Record<string, unknown>) : {};
  const legacy =
    analysisObject.metadata && typeof analysisObject.metadata === 'object'
      ? (analysisObject.metadata as Record<string, unknown>)
      : {};

  // A newer-contract snapshot returns an `unsupported` marker; that is not a
  // usable snapshot, so it degrades to legacy rather than being read as one.
  const hydrated = sanitizeIdentificationSnapshot(analysisObject.identificationSnapshot);
  const snapshot =
    hydrated && !('unsupported' in hydrated)
      ? (hydrated as PersistedIdentificationSnapshotV1)
      : null;

  const snapshotV2 = sanitizeIdentificationSnapshotV2(
    analysisObject.identificationSnapshotV2,
  ) as PersistedIdentificationSnapshotV2 | null;

  return resolveCanonicalFashionMetadata({ snapshotV2, snapshot, legacy });
}

/** Project canonical provenance onto the owned-item contract's field names. */
function toItemProvenance(
  metadata: CanonicalFashionMetadata,
): OwnedItemMetadataProvenance {
  return {
    category: metadata.provenance.category,
    subcategory: metadata.provenance.subtype,
    color: metadata.provenance.primaryColor,
    material: metadata.provenance.material,
    pattern: metadata.provenance.pattern,
    silhouette: metadata.provenance.silhouette,
    fit: metadata.provenance.fit,
    brand: metadata.provenance.brand,
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
  const meta = resolveSavedScanMetadata(row.analysis_result);
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
    subcategory: meta.subtype,
    color: meta.primaryColor,
    pattern: meta.pattern,
    material: meta.material,
    silhouette: meta.silhouette,
    fit: meta.fit,
    brand: meta.brand,
    brandEvidence: meta.brandEvidence,
    metadataProvenance: toItemProvenance(meta),
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

  // The model arrives with its snapshot already hydrated and validated by
  // `mapSavedScanRowToModel`. Before Closet V2 this path ignored it and
  // hard-coded subcategory/pattern/fit/brand to null, so a local scan lost
  // four fields the snapshot was holding the whole time.
  const meta = resolveCanonicalFashionMetadata({
    snapshotV2: scan.identificationSnapshotV2 ?? null,
    snapshot: scan.identificationSnapshot ?? null,
    legacy: {
      category: attributes.category,
      silhouette: attributes.silhouette,
      color_palette: attributes.color_palette,
      material_estimate: attributes.material_estimate,
      // KSB29-037. The projection omitted `pattern`, so for a scan with no
      // identification snapshot the resolver had no legacy source to fall back
      // to and pattern resolved absent — the value was sitting in the saved
      // attributes the whole time. Every reopened legacy scan lost its pattern
      // on this line.
      pattern: attributes.pattern,
      style_tags: attributes.style_tags,
      confidence_score: attributes.confidence_score,
    },
  });
  const category = meta.category;

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
    subcategory: meta.subtype,
    color: meta.primaryColor,
    pattern: meta.pattern,
    material: meta.material,
    silhouette: meta.silhouette,
    fit: meta.fit,
    brand: meta.brand,
    brandEvidence: meta.brandEvidence,
    metadataProvenance: toItemProvenance(meta),
    styleTags: meta.styleTags,
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
    // Inspiration uploads carry no garment identification, so there is nothing
    // to evidence and nothing to attribute a provenance to.
    brandEvidence: [],
    metadataProvenance: ABSENT_ITEM_METADATA_PROVENANCE,
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
    // Explicit user-initiated attachment step (Contract V2 server-resolved
    // reference), not background Library sync — must work while the
    // CLOUD_SAVED_SCANS background-sync feature stays deferred.
    const result = await upsertSavedScanRowForAttachment(localScan);
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
