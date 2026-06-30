/**
 * Pure helpers for converting ProductShelf Product items into the snapshot
 * shape accepted by dressing-room / style-object persistence.
 *
 * Snapshot normalization is intentionally conservative: any price that is
 * missing, empty, non-finite, or non-positive becomes `null` so the UI never
 * persists "$0.00" / "Free" placeholders for TEST catalog rows.
 */

export function toSnapshotPrice(
  price: string | number | null | undefined
): string | null {
  if (price === null || price === undefined || price === '') return null;
  if (typeof price === 'number' && (!Number.isFinite(price) || price <= 0))
    return null;
  return String(price);
}

export function normalizeForSnapshot<T extends { price?: unknown }>(
  product: T
): T & { price: string | null } {
  return {
    ...product,
    price: toSnapshotPrice(product.price as string | number | null | undefined),
  };
}
