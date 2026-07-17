const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('AnalysisCard formats persisted numeric price with saved currency', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components/AnalysisCard.tsx'), 'utf8');
  assert.match(source, /formatPersistedPrice/);
  assert.match(source, /option\.currency/);
  assert.match(source, /Intl\.NumberFormat/);
  assert.doesNotMatch(source, /\$\$\{option\.price\.toFixed/);
  assert.doesNotMatch(source, /`\$\$\{option\.price/);
});

test('PurchaseOptionsPanel renders persisted priceLabel without rediscovery', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'components/scan-results/PurchaseOptionsPanel.tsx'),
    'utf8',
  );
  assert.match(panel, /priceLabel/);
  assert.doesNotMatch(panel, /EXPO_PUBLIC_PRICE_DISCOVERY/);
});

test('library reopen keeps purchaseOptions even when discovery is unavailable', () => {
  const library = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
  assert.match(library, /purchaseOptions/);
  assert.match(library, /AnalysisCard|PurchaseOptionsPanel|commerce/i);
});
