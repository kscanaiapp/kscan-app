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

type SnapshotProductInput = {
  id?: unknown;
  external_product_id?: unknown;
  externalProductId?: unknown;
  displayName?: unknown;
  product_name?: unknown;
  productName?: unknown;
  name?: unknown;
  title?: unknown;
  retailer?: unknown;
  brand?: unknown;
  source?: unknown;
  merchant?: unknown;
  store?: unknown;
  price?: unknown;
  imageUrl?: unknown;
  image_url?: unknown;
  thumbnail?: unknown;
  thumbnailUrl?: unknown;
  image_src?: unknown;
  product_image_url?: unknown;
  imageCategory?: unknown;
  canonical_category?: unknown;
  category?: unknown;
  productUrl?: unknown;
  product_url?: unknown;
  purchaseUrl?: unknown;
  purchase_url?: unknown;
  url?: unknown;
  link?: unknown;
  affiliateUrl?: unknown;
};

type NormalizedSnapshotFields = {
  id: string | null;
  title: string | null;
  retailer: string | null;
  price: string | null;
  imageUrl: string | null;
  imageCategory: string | null;
  productUrl: string | null;
  purchaseUrl: string | null;
};

function toCleanText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function firstText(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const text = toCleanText(candidate);
    if (text) return text;
  }
  return null;
}

function firstRemoteUrl(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const text = toCleanText(candidate);
    if (text && /^https?:\/\//i.test(text)) return text;
  }
  return null;
}

export function normalizeForSnapshot<T extends SnapshotProductInput>(
  product: T
): T & NormalizedSnapshotFields {
  return {
    ...product,
    id: firstText(product.id, product.external_product_id, product.externalProductId),
    title: firstText(
      product.displayName,
      product.name,
      product.title,
      product.product_name,
      product.productName,
    ),
    retailer: firstText(product.retailer, product.brand, product.source, product.merchant, product.store),
    price: toSnapshotPrice(product.price as string | number | null | undefined),
    imageUrl: firstRemoteUrl(
      product.imageUrl,
      product.image_url,
      product.thumbnail,
      product.thumbnailUrl,
      product.image_src,
      product.product_image_url,
    ),
    imageCategory: firstText(product.imageCategory, product.canonical_category, product.category),
    productUrl: firstRemoteUrl(
      product.purchaseUrl,
      product.productUrl,
      product.affiliateUrl,
      product.product_url,
      product.purchase_url,
      product.url,
      product.link,
    ),
    purchaseUrl: firstRemoteUrl(product.purchaseUrl, product.purchase_url),
  };
}
