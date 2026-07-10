/**
 * Retailer-neutral product match contract.
 *
 * Matches carry enough information for display and deep-linking without
 * claiming checkout capability or preferring any specific retailer.
 */
export interface ProductMatch {
  id?: string;
  title: string;
  retailer: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  affiliateUrl?: string;
  similarity?: number;
  source?: string;
  availability?: string;
}

/**
 * Format a price safely for display. Returns undefined when price is missing.
 */
export function formatProductPrice(product: ProductMatch | undefined): string | undefined {
  if (!product || typeof product !== 'object') return undefined;
  if (typeof product.price !== 'number' || !Number.isFinite(product.price)) return undefined;
  const symbol = typeof product.currency === 'string' && product.currency.trim() ? product.currency.trim() : '$';
  return `${symbol}${product.price.toFixed(2)}`;
}
