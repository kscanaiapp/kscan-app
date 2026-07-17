import { supabase } from './supabaseClient';
import type { User } from '@supabase/supabase-js';
import { CLOUD_SAVED_SCANS_ENABLED } from '../constants/featureFlags';
import { isPurchaseOptionsSnapshot, normalizePurchaseOptions } from './purchaseOptions';

const COMMERCE_SNAPSHOT_VERSION = 1;

/**
 * Safe result shape for all cloud saved-scan operations.
 */
export interface SavedScanCloudResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  reason?: 'unauthenticated' | 'disabled' | 'network' | 'unknown' | 'actor_changed' | 'conflict';
  actorId?: string | null;
  tombstones?: SavedScanModel[];
}

/**
 * A cloud scan row returned from Supabase.
 */
export interface SavedScanRow {
  id: string;
  user_id: string;
  local_id: string | null;
  title: string | null;
  scan_type: string | null;
  analysis_result: Record<string, unknown>;
  products: unknown[];
  purchase_options?: unknown;
  image_uri: string | null;
  thumbnail_uri: string | null;
  source: string;
  saved_at: string;
  deleted_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Phase 2 additive remote media backing (may be absent on older schemas).
  storage_bucket?: string | null;
  storage_path?: string | null;
  media_status?: 'pending' | 'ready' | 'failed' | null;
  media_uploaded_at?: string | null;
}

/**
 * A scan model shaped like the local SavedScan used in the app.
 * Cloud scans merge into this shape so the UI needs no change.
 */
export interface SavedScanModel {
  cloudId?: string;
  id: string;               // local id or local_id from cloud
  ownerId?: string | null;
  createdAt: string;
  imageUri?: string | null;
  thumbnailUri: string | null;
  // Phase 2 additive durable media reference. May be present even when
  // imageUri is null (e.g. the local device file no longer exists but the
  // scan's image was already uploaded). See services/dressingRoomItemContract.ts
  // for how callers should resolve which image source to use.
  storageBucket?: string | null;
  storagePath?: string | null;
  mediaStatus?: 'pending' | 'ready' | 'failed' | null;
  mediaUploadedAt?: string | null;
  attributes: {
    category: string;
    silhouette: string;
    color_palette: string;
    material_estimate: string | null;
    style_tags: string[];
    confidence_score: number | null;
  };
  result: string;
  products: unknown[];
  purchaseOptions?: unknown[];
  commerceSnapshotVersion?: number;
  source: string;
  savedAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  metadata?: Record<string, unknown>;
}

// ── Safe result helpers ──────────────────────────────────────────────────────

function disabledResult(actorId?: string | null): SavedScanCloudResult {
  return {
    ok: false,
    error: 'Saved on this device. Cloud sync will retry later.',
    reason: 'disabled',
    actorId: actorId ?? null,
  };
}

function unauthenticatedResult(actorId?: string | null): SavedScanCloudResult {
  return {
    ok: false,
    error: 'Saved on this device. Cloud sync will retry later.',
    reason: 'unauthenticated',
    actorId: actorId ?? null,
  };
}

function networkResult(actorId?: string | null): SavedScanCloudResult {
  return {
    ok: false,
    error: 'Saved on this device. Cloud sync will retry later.',
    reason: 'network',
    actorId: actorId ?? null,
  };
}

function unknownResult(actorId?: string | null): SavedScanCloudResult {
  return {
    ok: false,
    error: 'Saved on this device. Cloud sync will retry later.',
    reason: 'unknown',
    actorId: actorId ?? null,
  };
}

function actorChangedResult(actorId?: string | null): SavedScanCloudResult {
  return {
    ok: false,
    error: 'Saved on this device. Cloud sync will retry later.',
    reason: 'actor_changed',
    actorId: actorId ?? null,
  };
}

function conflictResult(actorId?: string | null): SavedScanCloudResult {
  return {
    ok: false,
    error: 'This scan was deleted on another device.',
    reason: 'conflict',
    actorId: actorId ?? null,
  };
}

function successResult(
  data?: unknown,
  actorId?: string | null,
  tombstones?: SavedScanModel[],
): SavedScanCloudResult {
  return { ok: true, data, actorId: actorId ?? null, tombstones };
}

const VALID_SCAN_TYPES = new Set(['camera', 'upload', 'textscan', 'unknown']);

function normalizeScanType(value: string | null | undefined): string {
  return value && VALID_SCAN_TYPES.has(value) ? value : 'unknown';
}

async function getCurrentUser(client = supabase): Promise<User | null> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.user) return null;
  return data.session.user;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function commerceVersion(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = Number((metadata as Record<string, unknown>).commerce_snapshot_version);
  return Number.isFinite(value) && value >= 1 ? value : undefined;
}

function hasCommerceSnapshot(scan: SavedScanModel): boolean {
  const normalized = normalizePurchaseOptions(scan.purchaseOptions);
  return (
    Number(scan.commerceSnapshotVersion) >= 1 &&
    isPurchaseOptionsSnapshot(scan.purchaseOptions)
  ) || normalized.length > 0;
}

function recordTimestamp(scan: SavedScanModel | Partial<SavedScanRow>): number | null {
  const candidate = 'createdAt' in scan
    ? scan.updatedAt || scan.savedAt || scan.createdAt
    : (scan as Partial<SavedScanRow>).updated_at ||
      (scan as Partial<SavedScanRow>).saved_at ||
      (scan as Partial<SavedScanRow>).created_at;
  const parsed = Date.parse(candidate || '');
  return Number.isNaN(parsed) ? null : parsed;
}

function authorityCompare(
  left: { scan: SavedScanModel; kind: 'local' | 'cloud'; index: number },
  right: { scan: SavedScanModel; kind: 'local' | 'cloud'; index: number },
): number {
  const leftTime = recordTimestamp(left.scan);
  const rightTime = recordTimestamp(right.scan);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== null && rightTime === null) return 1;
  if (leftTime === null && rightTime !== null) return -1;
  if (left.kind !== right.kind) return left.kind === 'local' ? 1 : -1;
  const leftIdentity = `${left.scan.cloudId || ''}|${left.scan.id || ''}`;
  const rightIdentity = `${right.scan.cloudId || ''}|${right.scan.id || ''}`;
  const identityOrder = leftIdentity.localeCompare(rightIdentity);
  return identityOrder || left.index - right.index;
}

function resolveClientAndActor(
  clientOrActor?: string | typeof supabase,
  maybeClient?: typeof supabase,
): { client: typeof supabase; expectedActorId?: string } {
  if (typeof clientOrActor === 'string') {
    return { client: maybeClient || supabase, expectedActorId: clientOrActor };
  }
  return { client: clientOrActor || supabase, expectedActorId: undefined };
}

// ── Casing adapters ───────────────────────────────────────────────────────────

/**
 * Convert a frontend camelCase SavedScan model into a snake_case row for
 * Supabase. The service layer restricts which columns are written on update.
 * purchase_options is always a JavaScript array at the network boundary.
 */
export function mapSavedScanToRow(
  scan: SavedScanModel,
  userId: string,
): Omit<SavedScanRow, 'created_at' | 'updated_at' | 'id'> & { id?: string } {
  const purchaseOptions = normalizePurchaseOptions(scan.purchaseOptions);
  const explicitCommerce =
    hasOwn(scan, 'purchaseOptions') &&
    Number(scan.commerceSnapshotVersion) >= 1 &&
    isPurchaseOptionsSnapshot(scan.purchaseOptions);
  const metadata = scan.metadata && typeof scan.metadata === 'object' ? { ...scan.metadata } : {};
  if (explicitCommerce) metadata.commerce_snapshot_version = COMMERCE_SNAPSHOT_VERSION;

  const row: Omit<SavedScanRow, 'created_at' | 'updated_at' | 'id'> & { id?: string } = {
    user_id: userId,
    local_id: scan.id || null,
    title: scan.attributes?.category || null,
    scan_type: normalizeScanType(scan.source),
    analysis_result: scan.result ? { result: scan.result, metadata: scan.attributes } : {},
    products: Array.isArray(scan.products) ? scan.products.slice() : [],
    purchase_options: purchaseOptions,
    image_uri: scan.imageUri ?? null,
    thumbnail_uri: scan.thumbnailUri ?? null,
    source: 'mobile',
    saved_at: scan.savedAt || scan.createdAt || new Date().toISOString(),
    deleted_at: scan.deletedAt ?? null,
    metadata,
  };

  if (scan.cloudId) row.id = scan.cloudId;
  if (scan.storageBucket !== undefined) row.storage_bucket = scan.storageBucket;
  if (scan.storagePath !== undefined) row.storage_path = scan.storagePath;
  if (scan.mediaStatus !== undefined) row.media_status = scan.mediaStatus;
  if (scan.mediaUploadedAt !== undefined) row.media_uploaded_at = scan.mediaUploadedAt;
  return row;
}

/**
 * Convert a snake_case Supabase row into a camelCase SavedScan model.
 */
export function mapSavedScanRowToModel(row: SavedScanRow): SavedScanModel {
  const analysis = typeof row.analysis_result === 'object' && row.analysis_result !== null
    ? row.analysis_result
    : {};

  const metadata = typeof row.metadata === 'object' && row.metadata !== null
    ? row.metadata
    : {};

  const products = Array.isArray(row.products) ? row.products : [];
  const purchaseOptions = normalizePurchaseOptions(row.purchase_options);
  const snapshotVersion = commerceVersion(metadata) || (purchaseOptions.length > 0 ? 1 : undefined);

  const resultText = typeof analysis.result === 'string' ? analysis.result : '';

  const meta = typeof analysis.metadata === 'object' && analysis.metadata !== null
    ? analysis.metadata as Record<string, unknown>
    : {};

  return {
    cloudId: row.id,
    id: row.local_id || row.id,
    ownerId: row.user_id,
    createdAt: row.created_at,
    imageUri: row.image_uri,
    thumbnailUri: row.thumbnail_uri,
    storageBucket: row.storage_bucket ?? null,
    storagePath: row.storage_path ?? null,
    mediaStatus: row.media_status ?? null,
    mediaUploadedAt: row.media_uploaded_at ?? null,
    attributes: {
      category: typeof meta.category === 'string' ? meta.category : '',
      silhouette: typeof meta.silhouette === 'string' ? meta.silhouette : '',
      color_palette: typeof meta.color === 'string' ? meta.color : (typeof meta.color_palette === 'string' ? meta.color_palette : ''),
      material_estimate: typeof meta.material_estimate === 'string' ? meta.material_estimate : null,
      style_tags: Array.isArray(meta.style_tags) ? meta.style_tags.filter((tag): tag is string => typeof tag === 'string') : [],
      confidence_score: typeof meta.confidence_score === 'number' ? meta.confidence_score : null,
    },
    result: resultText,
    products,
    purchaseOptions,
    commerceSnapshotVersion: snapshotVersion,
    source: normalizeScanType(row.scan_type || row.source),
    savedAt: row.saved_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    metadata,
  };
}

// ── Cloud operations ───────────────────────────────────────────────────────────

/**
 * Save a single scan to the cloud. Upserts by user_id + local_id when the
 * scan has a local id. For cloud-only scans (no local_id), inserts a new row.
 *
 * Soft-deleted cloud rows are authoritative tombstones: a local retry returns
 * conflict and must not resurrect the delete. Newer timestamps own metadata,
 * analysis, products, and explicit commerce snapshots.
 */
export async function saveScanToCloud(
  scan: SavedScanModel,
  client = supabase,
  expectedActorId?: string,
): Promise<SavedScanCloudResult> {
  if (!CLOUD_SAVED_SCANS_ENABLED) return disabledResult(expectedActorId);

  const user = await getCurrentUser(client);
  if (!user) return unauthenticatedResult(expectedActorId);
  if (expectedActorId && user.id !== expectedActorId) return actorChangedResult(user.id);
  if (scan.ownerId && scan.ownerId !== user.id) return actorChangedResult(user.id);

  try {
    const row = mapSavedScanToRow(scan, user.id);

    if (row.local_id) {
      const { data: existing, error: selectError } = await client
        .from('saved_scans')
        .select('id, deleted_at, analysis_result, products, purchase_options, metadata, saved_at, updated_at')
        .eq('user_id', user.id)
        .eq('local_id', row.local_id)
        .maybeSingle();

      if (selectError) return networkResult(user.id);

      if (existing) {
        if (existing.deleted_at) return conflictResult(user.id);

        const incomingTime = recordTimestamp(scan);
        const existingTime = recordTimestamp(existing);
        const incomingIsCurrent = existingTime === null ||
          (incomingTime !== null && incomingTime >= existingTime);
        const existingMetadata = existing.metadata && typeof existing.metadata === 'object'
          ? existing.metadata as Record<string, unknown>
          : {};
        const updatePayload: Record<string, unknown> = {
          metadata: incomingIsCurrent
            ? { ...existingMetadata, ...row.metadata }
            : { ...row.metadata, ...existingMetadata },
        };

        if (incomingIsCurrent) {
          updatePayload.title = row.title;
          updatePayload.scan_type = row.scan_type;
          updatePayload.image_uri = row.image_uri;
          updatePayload.thumbnail_uri = row.thumbnail_uri;
          updatePayload.saved_at = row.saved_at;
          if (Object.keys(row.analysis_result).length > 0) {
            updatePayload.analysis_result = row.analysis_result;
          }
          updatePayload.products = row.products;
        } else {
          const existingAnalysis = existing.analysis_result;
          const hasExistingAnalysis = typeof existingAnalysis === 'object'
            && existingAnalysis !== null
            && Object.keys(existingAnalysis).length > 0;
          if (!hasExistingAnalysis) {
            updatePayload.analysis_result = row.analysis_result;
          }
          const existingProducts = existing.products;
          const hasExistingProducts = Array.isArray(existingProducts) && existingProducts.length > 0;
          if (!hasExistingProducts) {
            updatePayload.products = row.products;
          }
        }

        const incomingCommerceExplicit = hasOwn(scan, 'purchaseOptions') &&
          Number(scan.commerceSnapshotVersion) >= 1 &&
          isPurchaseOptionsSnapshot(scan.purchaseOptions);
        const existingOptions = normalizePurchaseOptions(existing.purchase_options);
        const existingCommerceExplicit = commerceVersion(existingMetadata) !== undefined
          || existingOptions.length > 0;
        if (incomingCommerceExplicit && (!existingCommerceExplicit || incomingIsCurrent)) {
          updatePayload.purchase_options = row.purchase_options;
          updatePayload.metadata = {
            ...(updatePayload.metadata as Record<string, unknown>),
            commerce_snapshot_version: COMMERCE_SNAPSHOT_VERSION,
          };
        }

        const { data: updated, error: updateError } = await client
          .from('saved_scans')
          .update(updatePayload)
          .eq('id', existing.id)
          .eq('user_id', user.id)
          .select('id')
          .maybeSingle();

        if (updateError || !updated?.id) return networkResult(user.id);
        return successResult(updated, user.id);
      }
    }

    const { error: insertError } = await client
      .from('saved_scans')
      .insert(row);

    if (insertError) return networkResult(user.id);
    return successResult(undefined, user.id);
  } catch {
    return unknownResult(expectedActorId);
  }
}

/**
 * List active cloud saved scans plus separate tombstones so merge cannot
 * resurrect deletes from stale local copies.
 */
export async function listCloudSavedScans(
  clientOrActor?: string | typeof supabase,
  maybeClient?: typeof supabase,
): Promise<SavedScanCloudResult> {
  const { client, expectedActorId } = resolveClientAndActor(clientOrActor, maybeClient);
  if (!CLOUD_SAVED_SCANS_ENABLED) return disabledResult(expectedActorId);

  const user = await getCurrentUser(client);
  if (!user) return unauthenticatedResult(expectedActorId);
  if (expectedActorId && user.id !== expectedActorId) return actorChangedResult(user.id);

  try {
    const { data, error } = await client
      .from('saved_scans')
      .select('*')
      .eq('user_id', user.id)
      .order('saved_at', { ascending: false });

    if (error) return networkResult(user.id);

    const rows: SavedScanRow[] = Array.isArray(data) ? data : [];
    const models = rows.map(mapSavedScanRowToModel);
    return successResult(
      models.filter((scan) => !scan.deletedAt),
      user.id,
      models.filter((scan) => Boolean(scan.deletedAt)),
    );
  } catch {
    return unknownResult(expectedActorId);
  }
}

/**
 * Soft-delete a cloud saved scan by its cloud id or by local_id if a local
 * scan is passed. Sets deleted_at = now(). Never hard-deletes.
 */
export async function softDeleteCloudSavedScan(
  idOrScan: { cloudId?: string; localId?: string } | string,
  clientOrActor?: string | typeof supabase,
  maybeClient?: typeof supabase,
): Promise<SavedScanCloudResult> {
  const { client, expectedActorId } = resolveClientAndActor(clientOrActor, maybeClient);
  if (!CLOUD_SAVED_SCANS_ENABLED) return disabledResult(expectedActorId);

  const user = await getCurrentUser(client);
  if (!user) return unauthenticatedResult(expectedActorId);
  if (expectedActorId && user.id !== expectedActorId) return actorChangedResult(user.id);

  let targetId: string | null = null;

  if (typeof idOrScan === 'string') {
    targetId = idOrScan;
  } else if (idOrScan?.cloudId) {
    targetId = idOrScan.cloudId;
  } else if (idOrScan?.localId) {
    const { data, error } = await client
      .from('saved_scans')
      .select('id')
      .eq('user_id', user.id)
      .eq('local_id', idOrScan.localId)
      .maybeSingle();
    if (error) return networkResult(user.id);
    targetId = data?.id || null;
    // Local-only delete is already complete when no cloud row exists.
    if (!targetId) return successResult(undefined, user.id);
  }

  if (!targetId) return unknownResult(user.id);

  try {
    const { data: updated, error } = await client
      .from('saved_scans')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', targetId)
      .eq('user_id', user.id)
      .select('id')
      .maybeSingle();

    if (error || !updated?.id) return networkResult(user.id);
    return successResult(updated, user.id);
  } catch {
    return unknownResult(user.id);
  }
}

/**
 * Sync an array of local scans to the cloud in a single batch upsert.
 * Partial failures are silently ignored; local scans remain visible.
 */
export async function syncLocalSavedScansToCloud(
  localScans: SavedScanModel[],
  clientOrActor?: string | typeof supabase,
  maybeClient?: typeof supabase,
): Promise<{ synced: number; failed: number; errors: string[] }> {
  const { client, expectedActorId } = resolveClientAndActor(clientOrActor, maybeClient);
  if (!CLOUD_SAVED_SCANS_ENABLED) return { synced: 0, failed: 0, errors: [] };

  const user = await getCurrentUser(client);
  if (!user) return { synced: 0, failed: 0, errors: [] };
  if (expectedActorId && user.id !== expectedActorId) {
    return { synced: 0, failed: 0, errors: ['actor_changed'] };
  }

  const eligible = expectedActorId
    ? localScans.filter((scan) => scan.ownerId === expectedActorId)
    : localScans;

  const errors: string[] = [];
  let synced = 0;

  for (const scan of eligible) {
    const result = await saveScanToCloud(scan, client, expectedActorId || user.id);
    if (result.ok) {
      synced += 1;
    } else {
      errors.push(result.error || 'Unknown sync error');
    }
    if (result.reason === 'actor_changed' || result.reason === 'unauthenticated') break;
  }

  return { synced, failed: errors.length, errors };
}

/**
 * Merge local and cloud scans into a single deduplicated list.
 *
 * Rules:
 * 1. Normalize both inputs to camelCase SavedScanModel.
 * 2. Tombstones (cloud rows with deletedAt) remove the identity group.
 * 3. Deduplicate by localId and cloudId aliases.
 * 4. Newest explicit commerce snapshot owns purchaseOptions (including []).
 * 5. Metadata-only / legacy rows without commerce markers cannot erase commerce.
 * 6. Remote-media fields are preserved from the best available source.
 * 7. Sort merged list by savedAt descending.
 */
export function mergeLocalAndCloudScans(
  localScans: SavedScanModel[],
  cloudScans: SavedScanModel[],
  actorId?: string,
): SavedScanModel[] {
  const entries = [
    ...localScans.map((scan, index) => ({ scan, kind: 'local' as const, index })),
    ...cloudScans.map((scan, index) => ({ scan, kind: 'cloud' as const, index })),
  ].filter(({ scan }) => !actorId || !scan.ownerId || scan.ownerId === actorId);

  const groups: Array<typeof entries> = [];
  const aliasToGroup = new Map<string, number>();

  for (const entry of entries) {
    const aliases = [
      entry.scan.id ? `local:${entry.scan.id}` : null,
      entry.scan.cloudId ? `cloud:${entry.scan.cloudId}` : null,
    ].filter((alias): alias is string => Boolean(alias));

    const matches = [...new Set(
      aliases.map((alias) => aliasToGroup.get(alias)).filter((v): v is number => v !== undefined),
    )];
    const groupIndex = matches.length > 0 ? matches[0] : groups.length;
    if (!groups[groupIndex]) groups[groupIndex] = [];

    for (const otherIndex of matches.slice(1)) {
      groups[groupIndex].push(...groups[otherIndex]);
      groups[otherIndex] = [];
    }

    groups[groupIndex].push(entry);
    for (const grouped of groups[groupIndex]) {
      if (grouped.scan.id) aliasToGroup.set(`local:${grouped.scan.id}`, groupIndex);
      if (grouped.scan.cloudId) aliasToGroup.set(`cloud:${grouped.scan.cloudId}`, groupIndex);
    }
  }

  const merged = groups.filter((group) => group.length > 0).flatMap((group) => {
    if (group.some(({ kind, scan }) => kind === 'cloud' && Boolean(scan.deletedAt))) return [];

    const winnerEntry = group.reduce((winner, candidate) =>
      authorityCompare(candidate, winner) > 0 ? candidate : winner,
    );
    const winner: SavedScanModel = { ...winnerEntry.scan };

    const commerceWinner = group
      .filter(({ scan }) => hasCommerceSnapshot(scan))
      .reduce<typeof group[number] | null>(
        (current, candidate) => (!current || authorityCompare(candidate, current) > 0 ? candidate : current),
        null,
      );
    winner.purchaseOptions = normalizePurchaseOptions(
      commerceWinner?.scan.purchaseOptions ?? winner.purchaseOptions,
    );
    winner.commerceSnapshotVersion = commerceWinner?.scan.commerceSnapshotVersion;

    if (!Array.isArray(winner.products) || winner.products.length === 0) {
      const productSource = group
        .filter(({ scan }) => Array.isArray(scan.products) && scan.products.length > 0)
        .reduce<typeof group[number] | null>(
          (current, candidate) => (!current || authorityCompare(candidate, current) > 0 ? candidate : current),
          null,
        );
      if (productSource) winner.products = productSource.scan.products.slice();
    }

    for (const field of ['cloudId', 'ownerId', 'storageBucket', 'storagePath', 'mediaStatus', 'mediaUploadedAt'] as const) {
      if (winner[field] === undefined || winner[field] === null) {
        const source = [...group]
          .sort((a, b) => authorityCompare(b, a))
          .find(({ scan }) => scan[field] !== undefined && scan[field] !== null);
        if (source) Object.assign(winner, { [field]: source.scan[field] });
      }
    }

    return [winner];
  });

  return merged.sort((left, right) => {
    const leftTime = recordTimestamp(left) ?? 0;
    const rightTime = recordTimestamp(right) ?? 0;
    return rightTime - leftTime || String(left.id).localeCompare(String(right.id));
  });
}

export { CLOUD_SAVED_SCANS_ENABLED };
