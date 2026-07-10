import type { ScanResponse } from './response';
import type { ProductMatch } from './productMatch';
import { formatProductPrice } from './productMatch';
import { formatAttributeLabel } from './fashionAttributes';

const MAX_SENTENCES = 3;

/**
 * Format a shared ScanResponse into a concise, plain-text summary suitable for
 * a wearable audio/display readout.
 *
 * Rules:
 * - Maximum three short sentences.
 * - Plain text only; no markdown, no URLs, no long retailer lists.
 * - Prioritizes category, silhouette, color, and strongest match.
 * - States uncertainty honestly.
 * - Handles missing prices and retailers gracefully.
 */
export function formatWearableScanSummary(response: ScanResponse | undefined | null): string {
  if (!response || typeof response !== 'object') {
    return 'No scan result available.';
  }

  if (response.status === 'error') {
    return response.error?.message ?? 'Scan failed. Please try again.';
  }

  if (response.status === 'non_fashion') {
    return response.message ?? 'This does not appear to be a fashion item.';
  }

  const attrs = response.attributes;
  const products = response.products ?? [];
  const topMatch = findTopMatch(products);

  const sentences: string[] = [];

  // Sentence 1: what we saw
  const seen = formatWhatWeSaw(attrs);
  if (seen) sentences.push(seen);

  // Sentence 2: strongest match
  const match = formatTopMatch(topMatch, attrs);
  if (match) sentences.push(match);

  // Sentence 3: confidence / uncertainty
  const confidence = formatConfidence(attrs, topMatch, products, response.status);
  if (confidence) sentences.push(confidence);

  const summary = sentences.slice(0, MAX_SENTENCES).join(' ');
  return summary || 'Fashion item detected.';
}

function formatWhatWeSaw(attrs: ScanResponse['attributes']): string | undefined {
  if (!attrs) return undefined;
  const label = formatAttributeLabel(attrs);
  if (attrs.silhouette) {
    return `Looks like ${prependArticle(label)} in a ${attrs.silhouette} silhouette.`;
  }
  return `Looks like ${prependArticle(label)}.`;
}

function formatTopMatch(match: ProductMatch | undefined, attrs: ScanResponse['attributes']): string | undefined {
  if (!match) return undefined;
  const parts: string[] = [];
  if (match.retailer && match.retailer !== 'Retailer unavailable') {
    parts.push(`from ${match.retailer}`);
  }
  const price = formatProductPrice(match);
  if (price) parts.push(`at ${price}`);
  if (parts.length === 0) return `Closest match: ${match.title}.`;
  return `Closest match is ${match.title} ${parts.join(' ')}.`;
}

function formatConfidence(
  attrs: ScanResponse['attributes'],
  match: ProductMatch | undefined,
  products: ProductMatch[],
  status: ScanResponse['status'],
): string | undefined {
  if (status === 'partial') {
    return 'Only partial details are available.';
  }
  if (products.length === 0) {
    return 'No matching products found.';
  }
  const confidence = attrs?.confidence ?? match?.similarity;
  if (typeof confidence === 'number') {
    if (confidence >= 0.85) return 'High confidence.';
    if (confidence >= 0.6) return 'Moderate confidence.';
    return 'Low confidence; results may vary.';
  }
  return undefined;
}

function findTopMatch(products: ProductMatch[]): ProductMatch | undefined {
  if (!Array.isArray(products) || products.length === 0) return undefined;
  const sorted = [...products]
    .filter((p) => p && typeof p === 'object')
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  return sorted[0];
}

function prependArticle(phrase: string): string {
  if (!phrase) return phrase;
  const normalized = phrase.trim().toLowerCase();
  const first = normalized[0];
  const article = first === 'a' || first === 'e' || first === 'i' || first === 'o' || first === 'u' ? 'an' : 'a';
  return `${article} ${normalized}`;
}
