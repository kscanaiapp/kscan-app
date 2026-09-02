/**
 * Build 34 Scanner audit — SCAN-009.
 *
 * The commerce card promises nothing about WHERE the link goes, because the
 * backend cannot promise it: `selectRetailerDestination` prefers a direct
 * retailer URL and falls back to whatever aggregator the provider returned
 * when the item carries no merchant link. Measured live on App Staging, 28 of
 * 33 destinations were Google Shopping listings while the card's stated
 * retailer was the merchant (H&M, Macy's, Nordstrom, ...).
 *
 * The visible CTA was already hedged ("View Options"); the accessibility hint
 * was not, and asserted "Opens the retailer product page" — a claim a
 * screen-reader user could not verify and that was false most of the time.
 *
 * This is a source-text contract test: the strings are static literals, and
 * the point is that no surface reintroduces the stronger claim.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Every surface that renders a scan commerce destination. */
const COMMERCE_SURFACES = [
  'components/scan-results/PurchaseOptionsPanel.tsx',
  'components/ProductShelf.tsx',
];

const FORBIDDEN_CLAIMS = [
  'Opens the retailer product page',
  "Opens the retailer's product page",
  'Opens the retailer website',
  'Opens the retailer site',
];

for (const rel of COMMERCE_SURFACES) {
  test(`${rel} does not promise a retailer destination it cannot guarantee`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const claim of FORBIDDEN_CLAIMS) {
      // Ignore the explanatory comment that names the old string.
      const codeOnly = src
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      assert.ok(
        !codeOnly.includes(claim),
        `${rel} states "${claim}", but the destination is the aggregator listing whenever ` +
          'the provider supplied no direct merchant link — which is the common case',
      );
    }
  });

  test(`${rel} still tells the user what the link does`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(
      src.includes('accessibilityHint'),
      `${rel} must keep an accessibility hint on its destination control — removing the ` +
        'claim must not mean removing the affordance description',
    );
    assert.ok(
      src.includes('Opens this listing in your browser'),
      `${rel} must state what is true for every destination`,
    );
  });
}

test('the visible call to action stays hedged, not a retailer promise', () => {
  const src = fs.readFileSync(path.join(ROOT, 'components/scan-results/PurchaseOptionsPanel.tsx'), 'utf8');
  assert.ok(src.includes('View Options'), 'the neutral CTA copy is the shipped one');
  for (const overclaim of ['Buy at', 'Buy on', 'Shop at ', 'Go to retailer']) {
    assert.ok(!src.includes(overclaim), `"${overclaim}" would promise a destination we do not control`);
  }
});
