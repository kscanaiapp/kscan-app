// Receipt & Purchase Intelligence V1 — CONFIRMED_ITEM_ATTRIBUTE_COVERAGE.
//
// The reason this feature exists is richer owned-item metadata (spec section
// 27). This is the measurement: for a set of Closet records, grouped by how
// they entered the Closet, the fraction of items that carry each attribute.
//
// It is a PURE function over records the device already holds. It sends
// nothing, logs nothing and stores nothing. It runs in owner QA and in tests.
// It is deliberately not a telemetry event: attribute presence per item is
// not in the section 38 allowlist, and aggregating it remotely would be a new
// data flow the spec did not authorize.
//
// It never compares across origins by itself. It reports each origin's
// coverage and item count, so a comparison is only drawn where both sides
// actually have items.

export const COVERAGE_ATTRIBUTES = [
  'brand',
  'category',
  'subtype',
  'color',
  'material',
  'purchasedSize',
  'priceWithCurrency',
  'purchaseDate',
  'productIdentifier',
] as const;
export type CoverageAttribute = typeof COVERAGE_ATTRIBUTES[number];

type AnyRecord = Record<string, unknown> & { purchase?: Record<string, unknown> | null };

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

function has(item: AnyRecord, attribute: CoverageAttribute): boolean {
  const p = item.purchase ?? null;
  switch (attribute) {
    case 'brand':
      return present(item.brand);
    case 'category':
      return present(item.category);
    case 'subtype':
      return present(item.subtype);
    case 'color':
      return present(item.primaryColor);
    case 'material':
      return present(item.material);
    case 'purchasedSize':
      return present(item.size);
    case 'priceWithCurrency':
      return !!p && typeof p.pricePaid === 'number' && present(p.currency);
    case 'purchaseDate':
      return !!p && present(p.purchaseDate);
    case 'productIdentifier':
      return !!p && (present(p.sku) || present(p.gtin) || present(p.retailerProductRef));
    default:
      return false;
  }
}

export type OriginCoverage = {
  itemCount: number;
  /** Fraction 0..1 per attribute, or null when the origin has no items. */
  coverage: Record<CoverageAttribute, number | null>;
};

export function computeAttributeCoverage(items: readonly AnyRecord[]): Record<string, OriginCoverage> {
  const groups = new Map<string, AnyRecord[]>();
  for (const item of items ?? []) {
    if (!item || typeof item !== 'object' || item.deletedAt) continue;
    const origin = typeof item.origin === 'string' ? item.origin : 'unknown';
    groups.set(origin, [...(groups.get(origin) ?? []), item]);
  }
  const out: Record<string, OriginCoverage> = {};
  for (const [origin, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const coverage = {} as Record<CoverageAttribute, number | null>;
    for (const attribute of COVERAGE_ATTRIBUTES) {
      coverage[attribute] = group.length
        ? Math.round((group.filter((i) => has(i, attribute)).length / group.length) * 1000) / 1000
        : null;
    }
    out[origin] = { itemCount: group.length, coverage };
  }
  return out;
}
