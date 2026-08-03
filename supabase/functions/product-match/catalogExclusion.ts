/**
 * Product Match V1 — deterministic production test-catalog exclusion gate.
 *
 * WHY THIS IS A STANDALONE MODULE AND NOT A FILTER CALL
 *
 * The production `product_catalog` table holds 14 rows and every one of them is
 * seeded test data:
 *
 *   source              'TEST'
 *   retailer            'K Scan Demo Catalog' | 'TEST_RETAILER_A' | 'TEST_RETAILER_B'
 *   brand               'KSCAN_TEST' | 'Test Brand A'…'Test Brand D'
 *   external_product_id 'kscan-test-…' | 'test-…'
 *
 * The table is world-readable — RLS policy `Public read product catalog`,
 * `qual = true`, roles `{anon, authenticated}` — and it IS being read on real
 * scans: `avg(catalog_count) = 3.10` across 58 provider-completed
 * `scan_intelligence_events`, 51 of which retrieved at least one row.
 *
 * Those rows have not reached users, and it is worth being precise about why:
 * `recommended_product_sources` is `["Serper"]` in every observed row, because
 * the similarity matcher's threshold-60 filter happens to exclude them. That is
 * a tuning coincidence, not a control. One threshold change, one new consumer of
 * the table, or one relevance rewrite surfaces `KSCAN_TEST` products to real
 * users.
 *
 * So this is a GATE, not a filter: a named, deterministic, independently
 * testable boundary that any current or future catalog reader can call, with a
 * counted result so exclusions are visible in telemetry rather than silent.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not delete, modify or hide anything in the database. Cleaning up the
 * production rows requires owner approval and is tracked separately; this gate
 * is the code-side containment that makes the cleanup non-urgent rather than a
 * substitute for it.
 */

/** Fields the gate inspects. Structural, so any row shape can be passed. */
export type CatalogRowLike = {
  source?: unknown;
  brand?: unknown;
  retailer?: unknown;
  external_product_id?: unknown;
  product_name?: unknown;
  product_url?: unknown;
};

/**
 * Every rule, named, so a rejection can be explained and a false positive can
 * be traced to one rule rather than to "the filter".
 */
export type ExclusionRule =
  | 'source_marked_test'
  | 'brand_marked_test'
  | 'retailer_marked_test'
  | 'external_id_test_prefix'
  | 'demo_catalog_retailer'
  | 'non_production_url';

/** Values of `source` that mean "not real inventory". */
const TEST_SOURCES = new Set(['test', 'demo', 'fixture', 'sample', 'seed', 'staging']);

/**
 * Hosts that cannot be a real retailer product page. `example.*` and `.test`
 * are reserved by RFC 2606 / 6761 and can never resolve to a live store, so a
 * catalog row pointing at one is definitionally not shoppable.
 */
const NON_PRODUCTION_HOST_PATTERNS = [
  /(^|\.)example\.(com|net|org)$/i,
  /\.test$/i,
  /\.invalid$/i,
  /\.local$/i,
  /(^|\.)localhost$/i,
];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Returns every rule a row violates, or `[]` if it is admissible.
 *
 * Returning ALL matching rules rather than short-circuiting on the first is
 * deliberate: when this gate is eventually pointed at a real catalog, the
 * distribution of which rules fire is how you find out whether a rule has
 * become over-broad.
 */
export function exclusionRulesFor(row: CatalogRowLike): ExclusionRule[] {
  const rules: ExclusionRule[] = [];

  const source = text(row.source).toLowerCase();
  if (source && TEST_SOURCES.has(source)) rules.push('source_marked_test');

  const brand = text(row.brand).toUpperCase();
  if (brand === 'TEST' || brand.startsWith('KSCAN_TEST') || brand.startsWith('TEST ') || brand.startsWith('TEST_')) {
    rules.push('brand_marked_test');
  }

  const retailer = text(row.retailer).toUpperCase();
  if (retailer.startsWith('TEST_') || retailer.startsWith('TEST ') || retailer === 'TEST') {
    rules.push('retailer_marked_test');
  }
  if (retailer.includes('DEMO CATALOG') || retailer.includes('DEMO_CATALOG')) {
    rules.push('demo_catalog_retailer');
  }

  const externalId = text(row.external_product_id).toLowerCase();
  if (externalId.startsWith('test-') || externalId.startsWith('kscan-test-') || externalId.startsWith('demo-')) {
    rules.push('external_id_test_prefix');
  }

  const url = text(row.product_url);
  if (url) {
    try {
      const host = new URL(url).hostname;
      if (NON_PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
        rules.push('non_production_url');
      }
    } catch {
      // An unparseable URL is not by itself evidence of test data — plenty of
      // real rows have malformed URLs — so it is left to the other rules.
    }
  }

  return rules;
}

/** Convenience predicate. */
export function isExcludedCatalogRow(row: CatalogRowLike): boolean {
  return exclusionRulesFor(row).length > 0;
}

export type CatalogGateResult<T> = {
  admitted: T[];
  excludedCount: number;
  /** How many rows each rule rejected. Zero-valued rules are omitted. */
  ruleCounts: Partial<Record<ExclusionRule, number>>;
};

/**
 * Applies the gate to a batch, counting exclusions by rule.
 *
 * The count is returned rather than logged so it can reach the retrieval report
 * and the telemetry event. A gate whose activity is invisible is a gate nobody
 * notices has stopped working.
 */
export function applyCatalogExclusionGate<T extends CatalogRowLike>(
  rows: T[],
): CatalogGateResult<T> {
  const admitted: T[] = [];
  const ruleCounts: Partial<Record<ExclusionRule, number>> = {};
  let excludedCount = 0;

  for (const row of rows) {
    const rules = exclusionRulesFor(row);
    if (rules.length === 0) {
      admitted.push(row);
      continue;
    }
    excludedCount += 1;
    for (const rule of rules) {
      ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
    }
  }

  return { admitted, excludedCount, ruleCounts };
}

/**
 * The exact production rows this gate was built against, as a frozen fixture.
 *
 * Kept in the module rather than a test file so the gate carries its own
 * evidence: if someone later loosens a rule, the test that fails will name the
 * real production row that would have escaped.
 */
export const KNOWN_PRODUCTION_TEST_ROWS: readonly CatalogRowLike[] = Object.freeze([
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-black-tailored-jacket' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-blue-denim-jacket' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-brown-leather-belt' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-gold-hoop-earrings' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'test-coat-1' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-leather-tote-bag' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-navy-puffer-jacket' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-ribbed-midi-dress' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-tan-chelsea-boots' },
  { source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog', external_product_id: 'kscan-test-tan-crossbody-bag' },
  { source: 'TEST', brand: 'Test Brand A', retailer: 'TEST_RETAILER_A', external_product_id: 'test-blazer-1' },
  { source: 'TEST', brand: 'Test Brand C', retailer: 'TEST_RETAILER_A', external_product_id: 'test-dress-1' },
  { source: 'TEST', brand: 'Test Brand B', retailer: 'TEST_RETAILER_B', external_product_id: 'test-blazer-2' },
  { source: 'TEST', brand: 'Test Brand D', retailer: 'TEST_RETAILER_B', external_product_id: 'test-sneakers-1' },
]);
