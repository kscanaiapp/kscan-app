import { supabase } from './supabaseClient';
import type { User } from '@supabase/supabase-js';
import { CLOUD_SAVED_SCANS_ENABLED } from '../constants/featureFlags';
import { normalizePurchaseOptions } from './dressingRoomCommerce';

/**
 * Safe result shape for all cloud saved-scan operations.
 */
export interface SavedScanCloudResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  reason?: 'unauthenticated' | 'disabled' | 'network' | 'unknown';
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
  /** Durable commerce snapshot. Column already exists in production
   *  (saved_scans.purchase_options jsonb NOT NULL DEFAULT '[]'), so mapping it
   *  needs no migration. Optional here so legacy rows selected without the
   *  column still map. */
  purchase_options?: unknown[];
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
  createdAt: string;
  imageUri?: string | null;
  thumbnailUri: string | null;
  // Phase 2 additive durable media reference. May be present even when
  // imageUri is null (e.g. the local device file no longer exists but the
  // scan's image was already uploaded). See services/dressingRoomItemContract.ts
  // for how callers should resolve which image source to use.
  storageBucket?: string | null;
  storagePath?: string | null;
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
  source: string;
  savedAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  metadata?: Record<string, unknown>;
}

// ── Safe result helpers ──────────────────────────────────────────────────────

function disabledResult(): SavedScanCloudResult {
  return { ok: false, error: 'Saved on this device. Cloud sync will retry later.', reason: 'disabled' };
}

function unauthenticatedResult(): SavedScanCloudResult {
  return { ok: false, error: 'Saved on this device. Cloud sync will retry later.', reason: 'unauthenticated' };
}

function networkResult(): SavedScanCloudResult {
  return { ok: false, error: 'Saved on this device. Cloud sync will retry later.', reason: 'network' };
}

function unknownResult(): SavedScanCloudResult {
  return { ok: false, error: 'Saved on this device. Cloud sync will retry later.', reason: 'unknown' };
}

function successResult(data?: unknown): SavedScanCloudResult {
  return { ok: true, data };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown };
  return (
    record.code === '23505' ||
    (typeof record.message === 'string' && /duplicate|unique constraint/i.test(record.message))
  );
}

async function getCurrentUser(client = supabase): Promise<User | null> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.user) return null;
  return data.session.user;
}

// ── Casing adapters ───────────────────────────────────────────────────────────

/**
 * Convert a frontend camelCase SavedScan model into a snake_case row for
 * Supabase. The service layer restricts which columns are written on update.
 */
export function mapSavedScanToRow(
  scan: SavedScanModel,
  userId: string,
): Omit<SavedScanRow, 'created_at' | 'updated_at' | 'id'> & { id?: string } {
  return {
    id: scan.cloudId,
    user_id: userId,
    local_id: scan.id || null,
    title: scan.attributes?.category || null,
    scan_type: scan.source || 'unknown',
    analysis_result: scan.result ? { result: scan.result, metadata: scan.attributes } : {},
    products: Array.isArray(scan.products) ? scan.products : [],
    purchase_options: normalizePurchaseOptions(scan.purchaseOptions),
    image_uri: scan.imageUri ?? null,
    thumbnail_uri: scan.thumbnailUri ?? null,
    source: 'mobile',
    saved_at: scan.savedAt || scan.createdAt || new Date().toISOString(),
    deleted_at: scan.deletedAt ?? null,
    metadata: scan.metadata || {},
  };
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

  const resultText = typeof analysis.result === 'string' ? analysis.result : '';

  const meta = typeof analysis.metadata === 'object' && analysis.metadata !== null
    ? analysis.metadata as Record<string, unknown>
    : {};

  return {
    cloudId: row.id,
    id: row.local_id || row.id,
    createdAt: row.created_at,
    imageUri: row.image_uri,
    thumbnailUri: row.thumbnail_uri,
    storageBucket: row.storage_bucket ?? null,
    storagePath: row.storage_path ?? null,
    attributes: {
      category: typeof meta.category === 'string' ? meta.category : '',
      silhouette: typeof meta.silhouette === 'string' ? meta.silhouette : '',
      color_palette: typeof meta.color === 'string' ? meta.color : (typeof meta.color_palette === 'string' ? meta.color_palette : ''),
      material_estimate: typeof meta.material_estimate === 'string' ? meta.material_estimate : null,
      style_tags: Array.isArray(meta.style_tags) ? meta.style_tags : [],
      confidence_score: typeof meta.confidence_score === 'number' ? meta.confidence_score : null,
    },
    result: resultText,
    products,
    purchaseOptions: normalizePurchaseOptions(row.purchase_options),
    source: row.scan_type || row.source || 'unknown',
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
 * If the matching row is soft-deleted, clears deleted_at to undelete.
 *
 * Gated by CLOUD_SAVED_SCANS_ENABLED: this is the background Library sync
 * entry point and stays dark while that feature is deferred.
 */
export async function saveScanToCloud(
  scan: SavedScanModel,
  client = supabase,
): Promise<SavedScanCloudResult> {
  if (!CLOUD_SAVED_SCANS_ENABLED) return disabledResult();
  return upsertSavedScanRowForAttachment(scan, client);
}

/**
 * Explicit, user-initiated saved_scan row creation for Elise visual
 * attachments (V17 hotfix). Contract V2 sends server-resolved saved_scan
 * REFERENCES, so attaching a Recent Scan requires a real cloud row — but
 * the deployed production profile intentionally defers the broad Library
 * background-sync feature, and the attachment saga must not depend on it.
 * Only the attachment preparation sagas call this, per selected scan, on a
 * direct user action; the Library sync gate above is unchanged.
 */
export async function upsertSavedScanRowForAttachment(
  scan: SavedScanModel,
  client = supabase,
): Promise<SavedScanCloudResult> {
  const user = await getCurrentUser(client);
  if (!user) return unauthenticatedResult();

  try {
    const row = mapSavedScanToRow(scan, user.id);

    // If a local_id exists, try to find an existing row first so we can
    // undelete it or update metadata without overwriting analysis_result.
    if (row.local_id) {
      const { data: existing, error: lookupError } = await client
        .from('saved_scans')
        .select('id, deleted_at, analysis_result, products, purchase_options')
        .eq('user_id', user.id)
        .eq('local_id', row.local_id)
        .maybeSingle();

      if (lookupError) return networkResult();

      if (existing) {
        const updatePayload: Record<string, unknown> = {
          deleted_at: null,
          updated_at: new Date().toISOString(),
          title: row.title,
          image_uri: row.image_uri,
          thumbnail_uri: row.thumbnail_uri,
          saved_at: row.saved_at,
          metadata: row.metadata,
        };

        // Only overwrite analysis_result and products for a new row or
        // explicit re-save when the existing row has empty values.
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

        // Empty or omitted commerce remains non-destructive for attachment and
        // metadata-only updates. A non-empty canonical snapshot is an explicit
        // enrichment/re-save and replaces stale offers on the existing row.
        const incomingPurchaseOptions = normalizePurchaseOptions(row.purchase_options);
        if (incomingPurchaseOptions.length > 0) {
          updatePayload.purchase_options = incomingPurchaseOptions;
        }

        const { error: updateError } = await client
          .from('saved_scans')
          .update(updatePayload)
          .eq('id', existing.id)
          .eq('user_id', user.id);

        if (updateError) return networkResult();
        return successResult({ id: existing.id });
      }
    }

    // No existing row → insert new.
    // Local scans always receive a server-generated UUID. Never trust a
    // caller-provided cloudId to choose another row's primary key.
    const { id: _callerProvidedId, ...rowWithGeneratedId } = row;
    const insertPayload = row.local_id ? rowWithGeneratedId : row;
    const { error: insertError } = await client
      .from('saved_scans')
      .insert(insertPayload);

    if (!insertError) return successResult();
    if (!row.local_id || !isUniqueViolation(insertError)) return networkResult();

    // Concurrent explicit/passive attempts can race between lookup and INSERT.
    // The unique (user_id, local_id) index prevents duplication; resolve the
    // winning row so every successful caller gets the same canonical id.
    const { data: canonical, error: canonicalError } = await client
      .from('saved_scans')
      .select('id, deleted_at')
      .eq('user_id', user.id)
      .eq('local_id', row.local_id)
      .maybeSingle();
    if (canonicalError || !canonical || canonical.deleted_at != null) return networkResult();
    return successResult({ id: canonical.id });
  } catch {
    return unknownResult();
  }
}

/**
 * List all non-deleted cloud saved scans for the current authenticated user.
 */
export async function listCloudSavedScans(
  client = supabase,
): Promise<SavedScanCloudResult> {
  if (!CLOUD_SAVED_SCANS_ENABLED) return disabledResult();

  const user = await getCurrentUser(client);
  if (!user) return unauthenticatedResult();

  try {
    const { data, error } = await client
      .from('saved_scans')
      .select('*')
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .order('saved_at', { ascending: false });

    if (error) return networkResult();

    const rows: SavedScanRow[] = Array.isArray(data) ? data : [];
    const models = rows.map(mapSavedScanRowToModel);
    return successResult(models);
  } catch {
    return unknownResult();
  }
}

/**
 * Soft-delete a cloud saved scan by its cloud id or by local_id if a local
 * scan is passed. Sets deleted_at = now(). Never hard-deletes.
 */
export async function softDeleteCloudSavedScan(
  idOrScan: { cloudId?: string; localId?: string } | string,
  client = supabase,
): Promise<SavedScanCloudResult> {
  if (!CLOUD_SAVED_SCANS_ENABLED) return disabledResult();

  const user = await getCurrentUser(client);
  if (!user) return unauthenticatedResult();

  let targetId: string | null = null;

  if (typeof idOrScan === 'string') {
    targetId = idOrScan;
  } else if (idOrScan?.cloudId) {
    targetId = idOrScan.cloudId;
  } else if (idOrScan?.localId) {
    // Look up the cloud row by local_id so deletion works even when the
    // caller only knows the local scan id.
    const { data } = await client
      .from('saved_scans')
      .select('id')
      .eq('user_id', user.id)
      .eq('local_id', idOrScan.localId)
      .maybeSingle();
    if (data?.id) targetId = data.id;
  }

  if (!targetId) return { ok: false, error: 'Scan not found.', reason: 'unknown' };

  try {
    const { error } = await client
      .from('saved_scans')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', targetId)
      .eq('user_id', user.id);

    if (error) return networkResult();
    return successResult();
  } catch {
    return unknownResult();
  }
}

/**
 * Sync an array of local scans to the cloud in a single batch upsert.
 * Partial failures are silently ignored; local scans remain visible.
 */
export async function syncLocalSavedScansToCloud(
  localScans: SavedScanModel[],
  client = supabase,
): Promise<{ synced: number; failed: number; errors: string[] }> {
  if (!CLOUD_SAVED_SCANS_ENABLED) return { synced: 0, failed: 0, errors: [] };

  const user = await getCurrentUser(client);
  if (!user) return { synced: 0, failed: 0, errors: [] };

  const synced: number[] = [];
  const failed: string[] = [];

  for (const scan of localScans) {
    const result = await saveScanToCloud(scan, client);
    if (result.ok) {
      synced.push(1);
    } else {
      failed.push(result.error || 'Unknown sync error');
    }
  }

  return { synced: synced.length, failed: failed.length, errors: failed };
}

/**
 * Merge local and cloud scans into a single deduplicated list.
 *
 * Rules:
 * 1. Normalize both inputs to camelCase SavedScanModel.
 * 2. Filter out cloud rows with deletedAt set (defensive double-check).
 * 3. Deduplicate by localId, then by cloudId.
 * 4. Timestamp comparison: latest wins. Missing timestamps prefer local.
 * 5. Cloud-only scans with local_id = null appear in the list.
 * 6. Sort merged list by savedAt descending.
 */
export function mergeLocalAndCloudScans(
  localScans: SavedScanModel[],
  cloudScans: SavedScanModel[],
): SavedScanModel[] {
  const localMap = new Map<string, SavedScanModel>();
  for (const scan of localScans) {
    const key = scan.id || scan.cloudId;
    if (key) localMap.set(key, scan);
  }

  const cloudMap = new Map<string, SavedScanModel>();
  for (const scan of cloudScans) {
    if (scan.deletedAt) continue; // defensive
    const key = scan.id || scan.cloudId;
    if (key) cloudMap.set(key, scan);
  }

  const merged = new Map<string, SavedScanModel>();

  /**
   * Timestamp resolution decides which whole record wins, but it must not
   * silently reset a stored commerce snapshot to []. If the winning side has no
   * purchase options and the losing side does, carry the surviving snapshot
   * across. Winner selection itself is unchanged.
   */
  const normalizedOptions = (scan: SavedScanModel) => {
    const camelCase = normalizePurchaseOptions(scan.purchaseOptions);
    if (camelCase.length > 0) return camelCase;
    return normalizePurchaseOptions(
      (scan as SavedScanModel & { purchase_options?: unknown }).purchase_options,
    );
  };

  const withCanonicalCommerce = (scan: SavedScanModel): SavedScanModel => ({
    ...scan,
    purchaseOptions: normalizedOptions(scan),
  });

  const withPreservedCommerce = (
    winner: SavedScanModel,
    loser: SavedScanModel,
  ): SavedScanModel => {
    const winnerOptions = normalizedOptions(winner);
    const loserOptions = normalizedOptions(loser);
    return {
      ...winner,
      purchaseOptions: winnerOptions.length > 0 ? winnerOptions : loserOptions,
    };
  };

  // Process local scans first.
  for (const [key, local] of localMap) {
    const cloud = cloudMap.get(key);
    if (cloud) {
      // Both exist — compare timestamps.
      const localTime = Date.parse(local.savedAt || local.createdAt || '0');
      const cloudTime = Date.parse(cloud.savedAt || cloud.createdAt || '0');
      if (!Number.isNaN(cloudTime) && !Number.isNaN(localTime)) {
        merged.set(
          key,
          cloudTime >= localTime
            ? withPreservedCommerce(cloud, local)
            : withPreservedCommerce(local, cloud),
        );
      } else if (!Number.isNaN(localTime)) {
        merged.set(key, withPreservedCommerce(local, cloud));
      } else if (!Number.isNaN(cloudTime)) {
        merged.set(key, withPreservedCommerce(cloud, local));
      } else {
        merged.set(key, withPreservedCommerce(local, cloud)); // prefer local when no timestamps
      }
    } else {
      merged.set(key, withCanonicalCommerce(local));
    }
  }

  // Add cloud-only scans.
  for (const [key, cloud] of cloudMap) {
    if (!merged.has(key)) {
      merged.set(key, withCanonicalCommerce(cloud));
    }
  }

  const result = Array.from(merged.values());
  result.sort((a, b) => {
    const aTime = Date.parse(a.savedAt || a.createdAt || '0');
    const bTime = Date.parse(b.savedAt || b.createdAt || '0');
    if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0;
    return bTime - aTime;
  });

  return result;
}
