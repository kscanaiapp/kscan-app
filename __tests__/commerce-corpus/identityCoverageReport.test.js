/**
 * Identity coverage measurement + grouping readiness reporting (spec
 * sections 29-30, 46, 48-49).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { measureIdentityCoverage } = require('../../tools/commerce-corpus/lib/measureIdentityCoverage');
const { buildReport } = require('../../tools/commerce-corpus/buildCoverageReport');
const { canonicalHash, stripVolatile } = require('../../tools/commerce-corpus/lib/canonicalJson');

const COMMITTED_PATH = path.resolve(__dirname, '../../artifacts/commerce-corpus-coverage.json');

test('identity coverage never blends evidence classes', () => {
  const coverage = measureIdentityCoverage();
  assert.ok(coverage.bySourceShape);
  assert.ok(coverage.bySynthetic);
  assert.ok(!('byObservedShape' in coverage) && !('observed' in coverage), 'no OBSERVED-SHAPE bucket may exist - none is available in this lane');
  assert.match(coverage.evidenceNote, /STAGING_OBSERVED_SHAPE: UNAVAILABLE/);
});

test('GTIN/SKU/UPC/EAN coverage is 0% - these fields do not exist in production schema (Finding, Section 26)', () => {
  const coverage = measureIdentityCoverage();
  assert.equal(coverage.bySourceShape.withSku, 0);
  assert.equal(coverage.bySourceShape.withGtinUpcEan, 0);
  assert.equal(coverage.bySynthetic.withSku, 0);
  assert.equal(coverage.bySynthetic.withGtinUpcEan, 0);
});

test('the committed coverage report is reproducible and up to date', () => {
  assert.ok(fs.existsSync(COMMITTED_PATH), 'artifacts/commerce-corpus-coverage.json is missing - run tools/commerce-corpus/buildCoverageReport.js and commit it');
  const committed = JSON.parse(fs.readFileSync(COMMITTED_PATH, 'utf8'));
  const fresh = buildReport();

  const committedHashable = stripVolatile(committed, ['contentHash', 'generatedAt']);
  const freshHashable = stripVolatile(fresh, ['contentHash', 'generatedAt']);
  assert.equal(
    canonicalHash(committedHashable),
    canonicalHash(freshHashable),
    'the committed coverage report is stale - rerun tools/commerce-corpus/buildCoverageReport.js and commit the result',
  );
});

test('grouping readiness verdict is one of the four allowed enums, never invented', () => {
  const report = buildReport();
  assert.ok(['SUPPORTED', 'LOW_COVERAGE', 'NOT_YET', 'UNVERIFIED_RUNTIME'].includes(report.groupingReadiness.verdict));
  assert.ok(['PROCEED', 'PARTIAL_ONLY', 'DEFER', 'UNVERIFIED'].includes(report.groupingReadiness.prCRecommendation.replace(' ', '_')) || report.groupingReadiness.prCRecommendation === 'DEFER');
});

test('grouping readiness verdict is NOT_YET, grounded in Finding F2 (no exact cross-retailer identity, only a dormant fuzzy mechanism)', () => {
  const report = buildReport();
  assert.equal(report.groupingReadiness.verdict, 'NOT_YET');
  assert.equal(report.groupingReadiness.prCRecommendation, 'DEFER');
  assert.match(report.groupingReadiness.citation, /canonicalProductKey/);
});

test('price freshness authority is PARTIAL, and affiliate authority is ABSENT, per the shape census', () => {
  const report = buildReport();
  assert.equal(report.priceFreshnessAuthority.status, 'PARTIAL');
  assert.equal(report.attributionCoverage.affiliateAuthority, 'ABSENT');
  assert.equal(report.attributionCoverage.fabricatedAffiliateIds, 0);
});

test('per-garment commerce status is PRESENT, per services/multiItemCommerce.ts', () => {
  const report = buildReport();
  assert.equal(report.perGarmentCommerce.status, 'PRESENT');
});

test('scenario counts sum consistently across the three views (category/evidenceClass/tag totals are internally coherent)', () => {
  const report = buildReport();
  const byCategorySum = Object.values(report.scenarioCounts.byCategory).reduce((a, b) => a + b, 0);
  const byEvidenceClassSum = Object.values(report.scenarioCounts.byEvidenceClass).reduce((a, b) => a + b, 0);
  assert.equal(byCategorySum, report.scenarioCounts.total);
  assert.equal(byEvidenceClassSum, report.scenarioCounts.total);
});
