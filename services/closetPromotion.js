/**
 * Recent Scan → Closet promotion.
 *
 * PRODUCT RULING: promotion is ADDITIVE, not a move.
 *   - the Recent Scan remains present and unmodified
 *   - its commerce snapshot is untouched
 *   - the Closet item carries ZERO commerce
 *   - deleting either record cannot corrupt the other
 *
 * This module never writes to services/library.js. It reads a scan, maps an
 * explicit non-commerce subset, and hands a draft to the Closet store, which
 * derives its own media copy. There is no code path here that can mutate,
 * soft-delete, or re-persist the source scan.
 */

import { createClosetItem, findClosetItemByLineage } from './closetLibrary';

/**
 * Recent Scan fields that must NEVER reach a Closet record.
 *
 * Kept as documentation and as the assertion surface for
 * __tests__/closetCommerceExclusion.test.js. The mapper below does not consult
 * this list at runtime — exclusion is achieved by explicit allowlisting, so a
 * commerce field introduced upstream tomorrow is dropped without this list
 * needing to know about it.
 */
export const FORBIDDEN_CLOSET_FIELDS = Object.freeze([
  'purchaseOptions',
  'recommendedProducts',
  'products',
  'commerceSnapshotVersion',
  'retailerUrl',
  'affiliateUrl',
  'productUrl',
  'price',
  'currency',
  'availability',
  'commerceRanking',
  'secondhand',
  'sneakerCommerce',
  'providerPayload',
  'signedUrl',
  'storageBucket',
  'storagePath',
  'debug',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Stable promotion lineage.
 *
 * The Recent Scan local id and the cloud Saved Scan UUID are NOT the same
 * value. `local_id` is the join key the cloud row is upserted against
 * (services/savedScansCloud.ts), and the merged model keeps
 * `id = row.local_id || row.id`. A scan therefore keeps its local id across
 * cloud canonicalization, which makes `local:<localId>` stable for the whole
 * lifetime of a device-originated scan. Cloud-only scans (no local_id) fall
 * back to `cloud:<uuid>`.
 *
 * Deliberately NOT used as identity: title, image filename, timestamp,
 * category, retailer metadata, product metadata.
 */
export function resolveScanLineageId(scan) {
  if (!scan || typeof scan !== 'object') return null;
  const localId = text(scan.id);
  const cloudId = text(scan.cloudId);

  // A local id that is not a UUID is a device-originated scan id.
  if (localId && !isUuid(localId)) return `local:${localId}`;
  if (cloudId) return `cloud:${cloudId}`;
  if (localId) return `cloud:${localId}`;
  return null;
}

/**
 * EXPLICIT NON-COMMERCE ALLOWLIST MAPPER.
 *
 * Every field on the returned draft is named here. The source object is never
 * spread. Adding a field to a Closet record must be a deliberate edit to this
 * function.
 */
export function mapScanToClosetDraft(scan, { clientRequestId } = {}) {
  if (!scan || typeof scan !== 'object') return null;

  const attributes = scan.attributes && typeof scan.attributes === 'object' ? scan.attributes : {};
  const category = text(attributes.category);
  const lineage = resolveScanLineageId(scan);
  if (!lineage) return null;

  const localId = text(scan.id);
  const cloudId = text(scan.cloudId);

  return {
    title: category || 'Closet item',
    category,
    notes: null,
    origin: 'recent_scan',
    sourceLocalScanId: localId && !isUuid(localId) ? localId : null,
    sourceSavedScanId: cloudId && isUuid(cloudId) ? cloudId : null,
    sourceLineageId: lineage,
    clientRequestId: text(clientRequestId),
  };
}

/**
 * Resolve the local media the Closet copy is derived from.
 *
 * Device-local testing pass: only on-device URIs are acceptable. A cloud-only
 * scan with no local image cannot be promoted here — that is reported rather
 * than silently producing an item with no durable media, and it introduces no
 * new image transit.
 */
export function resolvePromotionSourceUri(scan) {
  if (!scan || typeof scan !== 'object') return null;
  return text(scan.imageUri) || text(scan.thumbnailUri);
}

/**
 * Promote a Recent Scan into the Closet.
 *
 * Idempotent on (owner + stable lineage): a double tap, a retry, a refresh, or
 * a UI timeout after a successful commit all resolve to the SAME Closet item.
 *
 * @returns {Promise<{ok: true, item: object, deduped: boolean}
 *                 | {ok: false, reason: string}>}
 */
export async function promoteScanToCloset({ scan, actorRequest, ownerId }) {
  const draft = mapScanToClosetDraft(scan, { clientRequestId: actorRequest?.requestId });
  if (!draft) return { ok: false, reason: 'unresolvable_scan_lineage' };

  const sourceUri = resolvePromotionSourceUri(scan);
  if (!sourceUri) return { ok: false, reason: 'no_local_media_to_promote' };

  return createClosetItem({ sourceUri, draft, actorRequest, ownerId });
}

/** Has this scan already been promoted by this owner? Drives UI affordance state. */
export async function isScanPromoted(scan, ownerId) {
  const lineage = resolveScanLineageId(scan);
  if (!lineage) return false;
  return (await findClosetItemByLineage(lineage, ownerId)) != null;
}
