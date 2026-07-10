/**
 * Fashion-specific attribute contract.
 *
 * These attributes describe the garment/item detected in a scan. They are
 * intentionally fashion-specific and do not collapse into generic labels.
 */
export interface FashionAttributes {
  category?: string;
  subcategory?: string;
  silhouette?: string;
  fit?: string;
  color?: string;
  colorPalette?: string[];
  pattern?: string;
  materialEstimate?: string;
  texture?: string;
  styleTags?: string[];
  seasonality?: string[];
  occasionTags?: string[];
  confidence?: number;
}

/**
 * Deterministic normalization map for fashion vocabulary variants.
 *
 * Keys are incoming terms; values are the canonical term the contract
 * prefers. This preserves specificity without inventing retailer or brand
 * information.
 */
export const FASHION_VOCABULARY_NORMALIZATION: Record<string, string> = {
  // Silhouette / fit variants
  oversized: 'Oversized',
  boxy: 'Boxy',
  relaxed: 'Relaxed',
  loose: 'Relaxed',
  baggy: 'Oversized',
  fitted: 'Fitted',
  slim: 'Slim',
  skinny: 'Slim',
  tight: 'Fitted',
  flowy: 'Flowy',
  wideleg: 'Wide-leg',
  'wide-leg': 'Wide-leg',
  cropped: 'Cropped',
  layered: 'Layered',
  straight: 'Straight',
  structured: 'Tailored',
  unstructured: 'Relaxed',

  // Color variants
  navy: 'Navy',
  'dark blue': 'Navy',
  midnight: 'Navy',
  indigo: 'Indigo',
  charcoal: 'Charcoal',
  'charcoal gray': 'Charcoal',
  beige: 'Beige',
  tan: 'Beige',
  cream: 'Cream',
  offwhite: 'Off-white',
  'off-white': 'Off-white',

  // Material variants
  leather: 'Leather',
  'faux leather': 'Faux leather',
  pleather: 'Faux leather',
  denim: 'Denim',
  jean: 'Denim',
  cottonblend: 'Cotton blend',
  'cotton blend': 'Cotton blend',

  // Category / item variants
  sneaker: 'Sneaker',
  trainer: 'Sneaker',
  shoe: 'Shoe',
  coat: 'Coat',
  overcoat: 'Coat',
  jacket: 'Jacket',
  blazer: 'Blazer',
  dress: 'Dress',
  jumpsuit: 'Jumpsuit',
  hoodie: 'Hoodie',
  tee: 'T-shirt',
  tshirt: 'T-shirt',
  't-shirt': 'T-shirt',
  top: 'Top',
  blouse: 'Blouse',
  skirt: 'Skirt',
  pants: 'Pants',
  trousers: 'Trousers',
  jeans: 'Jeans',
  shorts: 'Shorts',
  bag: 'Bag',
  tote: 'Tote bag',
};

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, '')
    .trim();
}

/**
 * Normalize a single fashion vocabulary term to its canonical form.
 * Returns the trimmed original value when no mapping exists.
 */
export function normalizeFashionTerm(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const key = normalizeKey(trimmed);
  return FASHION_VOCABULARY_NORMALIZATION[key] ?? FASHION_VOCABULARY_NORMALIZATION[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Normalize a list of style tags using the fashion vocabulary map.
 */
export function normalizeStyleTags(tags: string[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  return tags
    .map((t) => normalizeFashionTerm(t))
    .filter((t) => {
      if (!t) return false;
      if (seen.has(t.toLowerCase())) return false;
      seen.add(t.toLowerCase());
      return true;
    });
}

/**
 * Build a short, deterministic display label from attributes.
 * Safe to call with sparse attributes.
 */
export function formatAttributeLabel(attrs: FashionAttributes | undefined): string {
  if (!attrs || typeof attrs !== 'object') return 'Fashion item';
  const parts: string[] = [];
  if (attrs.color) parts.push(attrs.color);
  if (attrs.materialEstimate) parts.push(attrs.materialEstimate);
  if (attrs.subcategory || attrs.category) parts.push(attrs.subcategory ?? attrs.category ?? '');
  const joined = parts.filter(Boolean).join(' ');
  return joined || 'Fashion item';
}
