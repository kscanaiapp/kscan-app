/**
 * Canonical Dressing Room item image-source contract.
 *
 * A candidate item may carry up to three independent signals for its image:
 *   1. `localUri` - a device-local file/content URI (only valid on-device,
 *                    never durable, never sent to the server as-is).
 *   2. `storageBucket` + `storagePath` - a durable, private Supabase Storage
 *                    reference. This is the source of truth once an image
 *                    has been uploaded; it survives app reinstalls and is
 *                    what gets persisted to `dressing_room_items`.
 *   3. `imageUrl` - an already-public, renderable `https://`/`http://` URL
 *                    (e.g. a retailer product image). Never a signed URL -
 *                    signed URLs are resolved at render time, not stored.
 *
 * `imageUrl: null` does NOT mean "no image" if a durable storage reference is
 * present - callers must resolve through this module rather than checking
 * `imageUrl` (or `localUri`) directly, which is the bug this module fixes.
 *
 * DR-1 also exports provenance helpers used by styleObjects when
 * DRESSING_ROOM_CANONICAL_ITEM_V1 is enabled. Image rules are unchanged.
 */

import type {
  CanonicalItemSource,
  CanonicalItemSourceKind,
  CanonicalSnapshotExtension,
} from '../types/canonicalDressingRoomItem';
import {
  collectRawPurchaseOptions,
  normalizePurchaseOptions,
} from './dressingRoomCommerce';
import { computeDressingRoomDedupeKey } from './dressingRoomDedupe';

export type DressingRoomImageCandidate = {
  localUri?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  imageUrl?: string | null;
};

export type DressingRoomImageSource =
  | { kind: 'storage'; storageBucket: string; storagePath: string }
  | { kind: 'remote'; imageUrl: string }
  | { kind: 'local'; localUri: string }
  | { kind: 'none' };

export function isRemoteImageUrl(value?: string | null): boolean {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

export function isLocalImageUri(value?: string | null): boolean {
  return /^(file|content|asset|ph):\/\//i.test(String(value ?? '').trim());
}

/**
 * Resolves the single best usable image source for a Dressing Room item
 * candidate, in durability order: an existing private storage reference is
 * preferred (no re-upload needed), then a public remote URL, then a
 * device-local file that would need to be uploaded.
 */
export function resolveDressingRoomImageSource(
  candidate: DressingRoomImageCandidate,
): DressingRoomImageSource {
  const storageBucket = candidate.storageBucket?.trim() || null;
  const storagePath = candidate.storagePath?.trim() || null;
  if (storageBucket && storagePath) {
    return { kind: 'storage', storageBucket, storagePath };
  }

  const imageUrl = candidate.imageUrl?.trim() || null;
  if (imageUrl && isRemoteImageUrl(imageUrl)) {
    // Signed Supabase URLs are never durable identity.
    if (/\/storage\/v1\/object\/sign\//i.test(imageUrl)) {
      return { kind: 'none' };
    }
    return { kind: 'remote', imageUrl };
  }

  const localUri = candidate.localUri?.trim() || null;
  if (localUri && isLocalImageUri(localUri)) {
    return { kind: 'local', localUri };
  }

  return { kind: 'none' };
}

export function hasUsableDressingRoomImageSource(candidate: DressingRoomImageCandidate): boolean {
  return resolveDressingRoomImageSource(candidate).kind !== 'none';
}

/**
 * User-facing explanation for why an item currently cannot be added, given it
 * has no usable image source. Used to keep the Add action visible-but-disabled
 * (with an explanation) instead of silently disappearing.
 */
export function describeMissingImageReason(): string {
  return "This item's image isn't available right now, so it can't be added yet.";
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

export function mapLegacySourceKind(
  sourceType: string | null | undefined,
): CanonicalItemSourceKind {
  const text = String(sourceType ?? '').trim().toLowerCase();
  if (text === 'product_match' || text === 'catalog_product') return 'catalog_product';
  if (text === 'style_library_scan' || text === 'saved_scan') return 'saved_scan';
  if (text === 'text-scan' || text === 'textscan') return 'textscan';
  if (text === 'upload_inspiration' || text === 'inspiration_item') return 'inspiration_item';
  if (text === 'live_scan' || text === 'scan_image' || text === 'scanner_single') return 'scanner_single';
  if (text === 'scanner_selected_item') return 'scanner_selected_item';
  if (text === 'scanner_multi_item') return 'scanner_multi_item';
  if (text === 'shared_room_item') return 'shared_room_item';
  if (text === 'dressing_room_item') return 'dressing_room_item';
  if (text === 'closet_item') return 'closet_item';
  return 'scanner_single';
}

export function buildCanonicalSource(input: {
  sourceType?: string | null;
  sourceId?: string | null;
  kind?: CanonicalItemSourceKind | null;
  scanId?: string | null;
  scanSessionId?: string | null;
  selectedItemId?: string | null;
  savedScanId?: string | null;
  closetItemId?: string | null;
  inspirationItemId?: string | null;
  providerProductId?: string | null;
  backendVersion?: string | null;
  creationSource?: string | null;
}): CanonicalItemSource {
  const kind = input.kind ?? mapLegacySourceKind(input.sourceType);
  const sourceId = cleanId(input.sourceId);
  return {
    kind,
    scanId: cleanId(input.scanId) ?? (kind.startsWith('scanner') || kind === 'textscan' ? sourceId : null),
    scanSessionId: cleanId(input.scanSessionId),
    selectedItemId: cleanId(input.selectedItemId),
    savedScanId:
      cleanId(input.savedScanId) ??
      (kind === 'saved_scan' || kind === 'closet_item' ? sourceId : null),
    closetItemId: cleanId(input.closetItemId),
    inspirationItemId:
      cleanId(input.inspirationItemId) ??
      (kind === 'inspiration_item' ? sourceId : null),
    providerProductId:
      cleanId(input.providerProductId) ??
      (kind === 'catalog_product' || kind === 'product_match' ? sourceId : null),
    backendVersion: cleanId(input.backendVersion),
    creationSource: cleanId(input.creationSource) ?? cleanId(input.sourceType),
  };
}

/**
 * Build the optional DR-1 snapshot extension (provenance + commerce + dedupe).
 * Callers merge into existing snapshot_payload without replacing legacy fields.
 */
export function buildCanonicalSnapshotExtension(input: {
  dressingRoomId: string;
  sourceType?: string | null;
  sourceId?: string | null;
  kind?: CanonicalItemSourceKind | null;
  scanId?: string | null;
  scanSessionId?: string | null;
  selectedItemId?: string | null;
  savedScanId?: string | null;
  inspirationItemId?: string | null;
  providerProductId?: string | null;
  backendVersion?: string | null;
  creationSource?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  imageDigest?: string | null;
  requestIdempotencyKey?: string | null;
  commerceSource?: Record<string, unknown> | null;
  includeCommerce: boolean;
  includeDedupe: boolean;
}): CanonicalSnapshotExtension {
  const source = buildCanonicalSource(input);
  const extension: CanonicalSnapshotExtension = {
    schemaVersion: 1,
    source,
  };

  if (input.includeCommerce) {
    const raw = collectRawPurchaseOptions(input.commerceSource ?? undefined);
    extension.purchaseOptions = normalizePurchaseOptions(raw);
  }

  if (input.includeDedupe) {
    const dedupe = computeDressingRoomDedupeKey({
      dressingRoomId: input.dressingRoomId,
      source,
      storageBucket: input.storageBucket,
      storagePath: input.storagePath,
      providerProductId: input.providerProductId,
      imageDigest: input.imageDigest,
      requestIdempotencyKey: input.requestIdempotencyKey,
    });
    extension.dedupeKey = dedupe.key;
    extension.dedupeStrategy = dedupe.strategy;
  }

  return extension;
}

/** Read a previously written dedupe key from snapshot_payload. */
export function readSnapshotDedupeKey(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const canonical = record.canonical;
  if (canonical && typeof canonical === 'object' && !Array.isArray(canonical)) {
    const key = (canonical as Record<string, unknown>).dedupeKey;
    if (typeof key === 'string' && key.trim()) return key.trim().toLowerCase();
  }
  if (typeof record.dedupeKey === 'string' && record.dedupeKey.trim()) {
    return record.dedupeKey.trim().toLowerCase();
  }
  return null;
}
