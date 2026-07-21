/**
 * Deterministic Dressing Room item dedupe keys.
 * Never merges different colors/variants/retailers with distinct offers.
 */

import type { CanonicalItemSource } from '../types/canonicalDressingRoomItem';

export type DedupeComputation = {
  key: string | null;
  strategy: string | null;
};

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text || null;
}

export function computeDressingRoomDedupeKey(input: {
  dressingRoomId: string;
  source: CanonicalItemSource;
  storageBucket?: string | null;
  storagePath?: string | null;
  providerProductId?: string | null;
  imageDigest?: string | null;
  requestIdempotencyKey?: string | null;
}): DedupeComputation {
  const roomId = clean(input.dressingRoomId);
  if (!roomId) return { key: null, strategy: null };

  const scanId = clean(input.source.scanId);
  const selectedItemId = clean(input.source.selectedItemId);
  if (scanId && selectedItemId) {
    return {
      key: `scan:${scanId}:item:${selectedItemId}:room:${roomId}`,
      strategy: 'scan_id+selected_item_id+room',
    };
  }

  const savedScanId = clean(input.source.savedScanId);
  if (savedScanId) {
    return {
      key: `saved_scan:${savedScanId}:room:${roomId}`,
      strategy: 'saved_scan_id+room',
    };
  }

  const inspirationId = clean(input.source.inspirationItemId);
  if (inspirationId) {
    return {
      key: `inspiration:${inspirationId}:room:${roomId}`,
      strategy: 'inspiration_item_id+room',
    };
  }

  const productId =
    clean(input.providerProductId) ||
    clean(input.source.providerProductId);
  if (productId) {
    return {
      key: `product:${productId}:room:${roomId}`,
      strategy: 'provider_product_id+room',
    };
  }

  const bucket = clean(input.storageBucket);
  const path = clean(input.storagePath);
  if (bucket && path) {
    return {
      key: `storage:${bucket}:${path}:room:${roomId}`,
      strategy: 'storage_object+room',
    };
  }

  const digest = clean(input.imageDigest);
  if (digest) {
    return {
      key: `digest:${digest}:room:${roomId}`,
      strategy: 'image_digest+room',
    };
  }

  const idem = clean(input.requestIdempotencyKey);
  if (idem) {
    return {
      key: `idem:${idem}:room:${roomId}`,
      strategy: 'request_idempotency+room',
    };
  }

  return { key: null, strategy: null };
}
