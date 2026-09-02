/**
 * Build 34 Scanner audit — SCAN-NC-004 and SCAN-NC-008.
 *
 * Two absence invariants the audit calls non-negotiable, and which nothing
 * previously pinned. An absence has to be tested as an absence: there is no
 * behaviour to exercise, so the control is that INTRODUCING the coupling is
 * caught.
 *
 * NC-004 — personalization firewall (section 4 / 48). Signature Style, Closet,
 * Packing, Wardrobe Concierge and Elise history may influence later ranking
 * where explicitly designed. None of them may reach what the Scanner says a
 * garment IS: the prompt, the response schema, attribute normalization, the
 * quality gate, or commerce query construction.
 *
 * NC-008 — core-feature firewall (section 61 / 62). Scanner accuracy is core,
 * not K+. No entitlement, subscription or tier check may reach identification
 * quality or commerce retrieval.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Every module that decides what a garment IS, or how it is searched for. */
const IDENTIFICATION_AND_RETRIEVAL = [
  'supabase/functions/scan-identify/index.ts',
  'supabase/functions/scan-identify/multiItemGarments.ts',
  'supabase/functions/scan-identify/scannerQualityGate.ts',
  'supabase/functions/scan-identify/qualityTuneNormalize.ts',
  'supabase/functions/scan-identify/qualityTuneCommerce.ts',
  'supabase/functions/scan-identify/scanCommerceRouter.ts',
  'supabase/functions/scan-identify/commerceRelevanceQueries.ts',
  'supabase/functions/scan-identify/commerceRelevanceColorMaterial.ts',
  'supabase/functions/scan-identify/scannerCategoryRoute.ts',
  'services/scanIdentification.ts',
  'services/scanIdentificationMapper.ts',
  'services/multiItemCommerce.ts',
  'services/commerceHydration.ts',
  'hooks/useKScan.js',
];

/** Read a file with its comments stripped: prose may name these concepts. */
function codeOf(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const PERSONALIZATION_TOKENS = [
  'signatureStyle', 'signature_style', 'styleDna', 'style_dna',
  'closetItems', 'closet_items', 'wardrobe', 'packingList', 'packing_list',
  'concierge', 'eliseHistory', 'elise_history', 'preferredBrands', 'preferred_brands',
  'purchaseHistory', 'purchase_history', 'userPreferences', 'user_preferences',
];

const ENTITLEMENT_TOKENS = [
  'kplus', 'kPlus', 'k_plus', 'entitlement', 'isPremium', 'is_premium',
  'subscriptionTier', 'subscription_tier', 'hasSubscription',
];

for (const rel of IDENTIFICATION_AND_RETRIEVAL) {
  test(`NC-004: ${rel} takes no personalization input`, () => {
    const code = codeOf(rel);
    for (const token of PERSONALIZATION_TOKENS) {
      assert.ok(
        !code.includes(token),
        `${rel} references "${token}". Personalization must never change what the garment is, ` +
          'what colour it appears to be, whether a logo is visible, whether brand evidence ' +
          'exists, or which image an item came from.',
      );
    }
  });

  test(`NC-008: ${rel} makes no entitlement decision`, () => {
    const code = codeOf(rel);
    for (const token of ENTITLEMENT_TOKENS) {
      assert.ok(
        !new RegExp(token, 'i').test(code),
        `${rel} references "${token}". Scanner accuracy is a core feature: a non-K+ user must ` +
          'get the same objective identification and the same commerce retrieval.',
      );
    }
  });
}

test('NC-004: the request the client sends carries no personalization field', () => {
  const code = codeOf('services/scanIdentification.ts');
  const start = code.indexOf('const legacyRequestBody');
  assert.ok(start > 0, 'the request body builder is missing');
  const body = code.slice(start, code.indexOf('};', start));

  // The complete allowlist of what a scan request may contain.
  const ALLOWED = [
    'imageBase64', 'source', 'localPrivacyFiltered', 'multiItemDetection',
    'requestMode', 'scanSessionId', 'imageDigestPrefix', 'selectedCandidate',
    'clientTimestamp',
  ];
  const keys = [...body.matchAll(/^\s*(?:\.\.\.\([^)]*\?\s*\{\s*)?([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm)]
    .map((m) => m[1]);
  for (const key of keys) {
    assert.ok(ALLOWED.includes(key),
      `the scan request carries an unexpected field "${key}" — every field in this body is sent ` +
      'with the image, so anything not on the allowlist is a new disclosure');
  }
});

/**
 * The gate-site pattern this firewall scans for.
 *
 * KPLUS-P2-002 — this was `source="([a-z]+)"`, which cannot match an
 * underscore. Three of the eight bounded KPlusSource values contain one
 * (`wardrobe_concierge`, `voice_scan`, `closet_intelligence`), so a K+ gate
 * added to this core commerce surface under any of them produced NO match at
 * all and left `gates` reading exactly `['watchlist']` — the control reported
 * PASS over the precise change it exists to forbid. `[^"]*` matches any source
 * attribute, including one outside the taxonomy entirely, so a new gate is
 * always seen and then judged on its value rather than on whether the scanner
 * happened to recognise its spelling.
 */
const KPLUS_GATE_SITE = /<KPlusGate\s+source="([^"]*)"/g;

/** The bounded K+ source taxonomy, read from its single source of truth. */
function kPlusSources() {
  const src = fs.readFileSync(path.join(ROOT, 'types/kplusSource.ts'), 'utf8');
  const start = src.indexOf('export const KPLUS_SOURCES');
  assert.ok(start >= 0, 'KPLUS_SOURCES must exist in types/kplusSource.ts');
  const end = src.indexOf('] as const;', start);
  assert.ok(end > start, 'KPLUS_SOURCES must be a closed as-const array');
  const values = [...src.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(values.length >= 2, 'the K+ source taxonomy must have been parsed, not silently empty');
  return values;
}

test('NC-008: the gate scanner can actually see every legal K+ source', () => {
  // A firewall built on a source-text scan is only as strong as its pattern.
  // This asserts the pattern itself, so the control can never again silently
  // stop matching the thing it is guarding against.
  for (const source of kPlusSources()) {
    const sample = `<KPlusGate source="${source}">`;
    const seen = [...sample.matchAll(new RegExp(KPLUS_GATE_SITE.source, 'g'))].map((m) => m[1]);
    assert.deepEqual(seen, [source],
      `the NC-008 gate scanner does not match source="${source}" — a K+ gate added to a core ` +
      'surface under that source would be invisible to this firewall');
  }
});

test('NC-008: the only K+ surface in Scan Results is the Watch affordance', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'components/scan-results/PurchaseOptionsPanel.tsx'), 'utf8',
  );
  const gates = [...panel.matchAll(new RegExp(KPLUS_GATE_SITE.source, 'g'))].map((m) => m[1]);
  assert.deepEqual(gates, ['watchlist'],
    'K+ may gate the Smart Watchlist action and nothing else on this surface — never the ' +
    'products, the prices, the retailers, or the identification');
});
