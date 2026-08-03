/**
 * Checkpoint 4.5 — adapters from the REAL stored shapes onto the flat
 * `ClientExistingRecord` the candidate selector consumes.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE SELECTOR
 *
 * `similarItemCandidates.ts` must not know how a Closet item or a Recent Scan
 * is stored. Those two schemas are large, versioned, partly optional, and — as
 * of this checkpoint — DIVERGENT between the platform lines:
 * `services/library.js`, `services/savedScansCloud.ts` and
 * `services/scanIdentification.ts` all differ, and `services/purchaseOptions.ts`
 * exists only on the Android line.
 *
 * So this module takes PLAIN OBJECTS and imports nothing. It reads fields
 * defensively by name and never calls a loader, which is what lets this file
 * stay byte-identical across both lines while the loaders around it do not.
 *
 * THE TWO SCHEMAS ARE NOT SYMMETRIC, AND THAT IS BY DESIGN
 *
 * A committed Closet record is COMMERCE-FREE by construction:
 * `FORBIDDEN_CLOSET_FIELDS` in `services/closetPromotion.js` blocks
 * `productUrl`, price and retailer data from ever reaching one, and the Closet
 * taxonomy has no `pattern`, no `silhouette`, no model and no SKU field at all
 * (`CLOSET_ITEM_TAXONOMY_FIELDS`, `services/closetLibrary.js`).
 *
 * The practical consequence, stated plainly because it bounds what this
 * feature can ever achieve: a CLOSET candidate can never carry
 * identifier-backed evidence. Every `authoritative_identifier_match` and
 * `shared_product_url` reason the backend can produce will come from a RECENT
 * SCANS candidate. Closet comparisons are attribute-only, permanently, unless
 * the Closet schema gains an identifier field — which is a product decision
 * well outside this checkpoint.
 *
 * NO IMAGE BYTES. Both adapters read image URI STRINGS that the record already
 * carries, preferring the thumbnail. Nothing here opens, decodes, measures or
 * uploads an image.
 */

import type { ClientExistingRecord } from './similarItemCandidates';

/** Trimmed string, or null. Never throws on a non-string. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** First non-empty string in an array (or the value itself if it is a string). */
function firstText(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const found = text(entry);
    if (found) return found;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Epoch ms from an ISO string, or null. Used only as an ordering tiebreak. */
function epochMs(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors `resolveScanLineageId` in `services/closetPromotion.js` EXACTLY.
 *
 * This is the join key that makes cross-source deduplication work: a Closet
 * item promoted from a scan stores that scan's lineage id in
 * `sourceLineageId`, and the scan itself has no reverse pointer. Computing the
 * scan's own lineage id here is the only way to recognise that the Closet item
 * and the Recent Scan are the same physical garment.
 *
 * Duplicated rather than imported because `closetPromotion.js` is a
 * CommonJS/JS module in the promotion path; importing it here would drag the
 * promotion closure into the scan path for one pure string function.
 * `__tests__/similarItemCandidateParity.test.js` asserts the two agree.
 */
export function scanLineageIdOf(scan: Record<string, unknown>): string | null {
  const localId = text(scan.id);
  const cloudId = text(scan.cloudId);
  if (localId && !UUID.test(localId)) return `local:${localId}`;
  if (cloudId) return `cloud:${cloudId}`;
  if (localId) return `cloud:${localId}`;
  return null;
}

/**
 * Image quality hint from what the record actually holds.
 *
 * Only ever distinguishes "there is a reference to show" from "there is not".
 * It never inspects pixels — a genuine `poor` signal would require decoding
 * the image, which this checkpoint explicitly does not do. `poor` is therefore
 * only produced when the record itself already declares it.
 */
function imageQualityOf(
  imageUri: string | null,
  declared: unknown,
): 'ok' | 'poor' | 'missing' {
  const hint = text(declared);
  if (hint === 'poor') return 'poor';
  return imageUri ? 'ok' : 'missing';
}

// ── Closet ──────────────────────────────────────────────────────────────────

/**
 * Maps ONE raw committed Closet record.
 *
 * Must be given the RAW record from `loadCloset` / `loadClosetTyped`, not the
 * screen projection: `ClosetItemProjection` strips `sourceLineageId` (see
 * `CLOSET_ITEM_INTERNAL_FIELDS` in `services/closetItemProjection.ts`), and
 * without it a promoted item cannot be recognised as the same garment as the
 * scan it came from. Returns null when the record has no usable id.
 */
export function closetRecordToCandidate(raw: unknown): ClientExistingRecord | null {
  const item = record(raw);
  const id = text(item.id);
  if (!id) return null;

  // Thumbnail first: it is the smaller reference and the one a side-by-side
  // comparison actually wants. Neither is fetched here.
  const imageUri = text(item.thumbnailUri) ?? text(item.imageUri);

  return {
    id,
    source: 'closet',
    label: text(item.title) ?? text(item.displaySummary),
    imageUri,
    brand: text(item.brand),
    // Closet has no model field. Left null rather than approximated from
    // `title`, which is a user-editable label and would produce phantom
    // `same_model_tokens` agreements.
    model: null,
    canonicalCategory: text(item.category),
    subtype: text(item.subtype) ?? text(item.clothingType),
    color: text(item.primaryColor),
    material: firstText(item.material),
    // No silhouette, no pattern, no productUrl, no authoritativeId — see the
    // module header. These are absent from the Closet schema by design.
    silhouette: null,
    pattern: null,
    productUrl: null,
    authoritativeId: null,
    imageQuality: imageQualityOf(imageUri, item.imageQuality),
    status: text(item.deletedAt) ? 'deleted' : 'active',
    updatedAtMs: epochMs(item.updatedAt) ?? epochMs(item.createdAt),
    // The join key to the Recent Scan this item was promoted from, if any.
    mirrorOfId: text(item.sourceLineageId),
  };
}

// ── Recent Scans ────────────────────────────────────────────────────────────

/**
 * Maps ONE Recent Scan.
 *
 * A scan carries its identification at up to three levels of richness, and
 * only the first is guaranteed present:
 *
 *   attributes              always — category, silhouette, colour palette,
 *                           material estimate. No brand, no pattern, no model.
 *   identificationSnapshot  optional (IMG-008) — adds brand, pattern, richer
 *                           colours and materials.
 *   identificationSnapshotV2 optional (Phase 2B.2) — the same, plus
 *                           `exactProduct.{brand,model,sku}`, which is the ONLY
 *                           place a model or SKU exists anywhere on a scan.
 *
 * Read strongest-first with fallback, so a scan that predates either snapshot
 * still produces a usable candidate rather than being silently dropped.
 */
export function recentScanRecordToCandidate(raw: unknown): ClientExistingRecord | null {
  const scan = record(raw);
  const id = text(scan.id);
  if (!id) return null;

  const attributes = record(scan.attributes);
  const snapshot = record(scan.identificationSnapshot);
  const snapshotV2 = record(scan.identificationSnapshotV2);
  const itemV2 = record(snapshotV2.item);
  const exactProduct = record(snapshotV2.exactProduct);

  const brandV2 = record(itemV2.brand);
  const brandV1 = record(snapshot.brand);
  const colorsV2 = record(itemV2.colors);
  const colorsV1 = record(snapshot.colors);

  const imageUri = text(scan.thumbnailUri) ?? text(scan.imageUri);

  // Commerce lives on the scan, unlike on a Closet item. Read the FIRST
  // purchase option's product URL by field name only — `purchaseOptions.ts`
  // exists on one platform line and not the other, so this must never import
  // that module.
  const purchaseOptions = Array.isArray(scan.purchaseOptions) ? scan.purchaseOptions : [];
  const productUrl = purchaseOptions.length > 0
    ? text(record(purchaseOptions[0]).productUrl)
    : null;

  return {
    id,
    source: 'recent_scan',
    label: text(scan.title) ?? text(attributes.category),
    imageUri,
    brand: text(brandV2.value) ?? text(brandV1.value) ?? text(exactProduct.brand),
    // The only model a scan can have.
    model: text(exactProduct.model),
    canonicalCategory: text(itemV2.category) ?? text(snapshot.category) ?? text(attributes.category),
    subtype: text(itemV2.subtype) ?? text(snapshot.subtype),
    color: text(colorsV2.primary) ?? text(colorsV1.primary) ?? firstText(attributes.color_palette),
    material: firstText(itemV2.material) ?? firstText(snapshot.material)
      ?? text(attributes.material_estimate),
    silhouette: firstText(itemV2.silhouette) ?? firstText(snapshot.silhouette)
      ?? text(attributes.silhouette),
    pattern: firstText(itemV2.pattern) ?? firstText(snapshot.pattern),
    productUrl,
    authoritativeId: text(exactProduct.sku),
    imageQuality: imageQualityOf(imageUri, scan.imageQuality),
    status: text(scan.deletedAt) ? 'deleted' : 'active',
    updatedAtMs: epochMs(scan.createdAt),
    // A scan's own lineage id, so a Closet item promoted FROM it collapses
    // onto it during deduplication.
    mirrorOfId: scanLineageIdOf(scan),
  };
}

/** Maps a list, dropping unusable entries. Never throws. */
export function closetRecordsToCandidates(rawList: unknown): ClientExistingRecord[] {
  if (!Array.isArray(rawList)) return [];
  const out: ClientExistingRecord[] = [];
  for (const raw of rawList) {
    const mapped = closetRecordToCandidate(raw);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Maps a list, dropping unusable entries. Never throws. */
export function recentScanRecordsToCandidates(rawList: unknown): ClientExistingRecord[] {
  if (!Array.isArray(rawList)) return [];
  const out: ClientExistingRecord[] = [];
  for (const raw of rawList) {
    const mapped = recentScanRecordToCandidate(raw);
    if (mapped) out.push(mapped);
  }
  return out;
}
