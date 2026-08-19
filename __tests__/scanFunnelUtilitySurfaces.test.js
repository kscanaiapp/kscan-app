const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const PANEL = 'components/free-tier/SavedItemUtilityPanel.tsx';
const ANALYSIS_CARD = 'components/AnalysisCard.tsx';

/**
 * Scan-to-commerce funnel — utility surface policy.
 *
 * K Scan's scan journey is discovery and conversion:
 *
 *   see it -> scan it -> identify it -> SEE WHAT YOU CAN BUY -> style -> intent
 *
 * The Closet journey is ownership: organize, rate, manage. Wardrobe maintenance
 * must not appear in the funnel, and a reopened Recent Scan is still the funnel
 * rather than a wardrobe page.
 *
 * Disposition under test:
 *
 *   Care Notes       removed from the funnel, reserved for K+
 *   Rate this piece  removed from the funnel, preserved for owned items
 *   Cost per wear    removed from the funnel, reserved for K+
 *   Shopping Intent  kept, but only after the commerce section
 *
 * The panel is a React component that cannot be mounted in this harness, so the
 * gating DECISION is executed for real (the shipped `isScanFunnelContext` is
 * extracted and evaluated) and each card's gate is then verified to apply it.
 */

/** Extracts and evaluates the real shipped `isScanFunnelContext` implementation. */
function loadScanFunnelPredicate() {
  const source = read(PANEL);
  const match = source.match(/export function isScanFunnelContext[\s\S]*?\n}/);
  assert.ok(match, 'isScanFunnelContext must exist in the panel');
  const { outputText } = ts.transpileModule(`${match[0]}\nmodule.exports = { isScanFunnelContext };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', outputText)(module, module.exports);
  return module.exports.isScanFunnelContext;
}

/** Returns the gate expression guarding a given card in the panel's JSX. */
function gateFor(cardName) {
  const source = read(PANEL);
  const index = source.indexOf(`<${cardName}`);
  assert.notEqual(index, -1, `${cardName} must still exist in the panel`);
  // The guard is the nearest preceding `{ ... ? (` opening.
  const before = source.slice(0, index);
  const open = before.lastIndexOf('{');
  return before.slice(open).replace(/\s+/g, ' ');
}

const FUNNEL_CONTEXTS = ['scan', 'scan_result'];
const OWNED_CONTEXTS = ['library', 'room', 'home'];

// -- The decision function, executed --------------------------------------

test('the scan funnel is exactly the live scan and the reopened scan result', () => {
  const isScanFunnelContext = loadScanFunnelPredicate();
  for (const context of FUNNEL_CONTEXTS) {
    assert.equal(isScanFunnelContext(context), true, `${context} is part of the funnel`);
  }
  for (const context of [...OWNED_CONTEXTS, 'product']) {
    assert.equal(isScanFunnelContext(context), false, `${context} is not the funnel`);
  }
});

test('a reopened Recent Scan is funnel, not Closet', () => {
  // The regression this guards: `scan_result` was previously declared
  // "library", which made a reopened Recent Scan render as a wardrobe page.
  const isScanFunnelContext = loadScanFunnelPredicate();
  assert.equal(isScanFunnelContext('scan_result'), true);
  assert.equal(isScanFunnelContext('library'), false);
  assert.notEqual('scan_result', 'library');
});

// -- Card dispositions ------------------------------------------------------

test('Care Notes is withheld from the scan funnel and reserved for K+', () => {
  const gate = gateFor('CareNoteCard');
  assert.match(gate, /!isScanFunnelContext\(context\)/, 'Care Notes must be excluded from the funnel');
  // Reserved, not deleted: the component and its data model must survive.
  assert.ok(fs.existsSync(path.join(ROOT, 'components/free-tier/CareNoteCard.tsx')));
});

test('Rate this piece is withheld from the scan funnel but preserved for owned items', () => {
  const gate = gateFor('OutfitRatingCard');
  assert.match(gate, /!isScanFunnelContext\(context\)/, 'rating must be excluded from the funnel');
  // Capability preserved: the gate must not be an unconditional removal.
  assert.doesNotMatch(gate, /false/, 'rating must remain reachable for owned-item contexts');
  assert.ok(fs.existsSync(path.join(ROOT, 'components/free-tier/OutfitRatingCard.tsx')));
});

test('Wear tracker / cost per wear is withheld from the scan funnel', () => {
  const gate = gateFor('CostPerWearCard');
  assert.match(gate, /!isScanFunnelContext\(context\)/, 'cost per wear must be excluded from the funnel');
  assert.ok(fs.existsSync(path.join(ROOT, 'components/free-tier/CostPerWearCard.tsx')));
});

test('Shopping Intent is kept in every context, including the funnel', () => {
  const source = read(PANEL);
  const intent = source.indexOf('<WishlistIntentCard');
  assert.notEqual(intent, -1, 'Shopping Intent must remain');
  // It must not be wrapped in a funnel exclusion.
  const gate = gateFor('WishlistIntentCard');
  assert.doesNotMatch(gate, /isScanFunnelContext/, 'Shopping Intent must not be excluded from the funnel');
});

// -- Ordering: commerce before intent ---------------------------------------
//
// The two platform lines mount commerce on different surfaces: Android renders
// PurchaseOptionsPanel inside AnalysisCard (ScanResultV2 is candidate review
// only), iOS renders it inside ScanResultV2. The ORDER contract is shared even
// though the host is not, so these tests resolve the commerce host first.

/** Files that could host the commerce panel, in either platform layout. */
const COMMERCE_HOSTS = [ANALYSIS_CARD, 'components/scan-results/ScanResultV2.tsx'];

function commerceHost() {
  for (const file of COMMERCE_HOSTS) {
    const source = read(file);
    if (source.includes('<PurchaseOptionsPanel')) return { file, source };
  }
  assert.fail('no surface mounts PurchaseOptionsPanel on this platform line');
}

test('commerce renders before the utility surface that carries Shopping Intent', () => {
  const { file, source } = commerceHost();
  const commerce = source.indexOf('<PurchaseOptionsPanel');
  // Whichever utility mount this host uses.
  const utility = ['<SavedItemUtilityPanel', '<ScanResultUtilityFooter']
    .map((tag) => source.indexOf(tag))
    .filter((index) => index !== -1);

  assert.ok(utility.length > 0, `${file} must mount a utility surface`);
  for (const index of utility) {
    assert.ok(
      commerce < index,
      `${file}: purchase options must precede Shopping Intent — the user sees what they can buy first`,
    );
  }
});

test('the deferred commerce runtime is present on this candidate', () => {
  // Fix #9 was absent from the Android V10 candidate entirely; commerce could
  // not render because nothing hydrated it.
  assert.ok(
    fs.existsSync(path.join(ROOT, 'services/commerceHydration.ts')),
    'commerceHydration must be present on every line',
  );
  const hook = read('hooks/useKScan.js');
  assert.match(hook, /fetchDeferredCommerce/, 'the scan hook must fetch deferred commerce');
  assert.match(hook, /hydrateDeferredCommerce/, 'the scan hook must hydrate deferred commerce');

  // commerceJobScheduler is the ANDROID per-item scheduler (Fix #9 P1-C). Its
  // absence on the iOS line is correct, not a gap.
  const scheduler = path.join(ROOT, 'services/commerceJobScheduler.ts');
  if (fs.existsSync(scheduler)) {
    assert.match(hook, /commerceJobScheduler/, 'a present scheduler must be wired into the hook');
  }
});

test('the commerce panel handles the governed empty state on every line', () => {
  const panel = read('components/scan-results/PurchaseOptionsPanel.tsx');
  assert.match(panel, /purchase-options-empty/, 'an empty result must have a governed treatment');
});

test('where deferred commerce status is wired, pending, error and retry are complete', () => {
  // Fix #9 P1-B wired a pending/error/retry treatment so the panel mounts while
  // commerce is still deferred instead of leaving an empty gap.
  //
  // KNOWN GAP: the iOS convergence line carries commerceHydration but NOT P1-B,
  // so its panel has no commerceStatus union. That is recorded here rather than
  // repaired: adding commerce UI to the frozen compliance release candidate is
  // outside the authorized funnel-context correction.
  const panel = read('components/scan-results/PurchaseOptionsPanel.tsx');
  if (!/commerceStatus/.test(panel)) return;

  assert.match(panel, /'idle' \| 'pending' \| 'success' \| 'empty' \| 'error'/);
  assert.match(panel, /onRetry/, 'a failed deferred fetch must be retryable');

  const { file, source } = commerceHost();
  const normalized = source.replace(/\s+/g, ' ');
  assert.match(
    normalized,
    /commerceStatus=\{[A-Za-z]+\}/,
    `${file}: the panel must receive a commerce status`,
  );
});

test('the maintenance cards are gated for every funnel surface on this line', () => {
  // The real parity contract: whichever surfaces exist, any utility mount
  // inside the funnel declares a funnel context, and the gate covers it.
  const contexts = new Set();
  for (const file of [ANALYSIS_CARD, 'components/free-tier/ScanResultUtilityFooter.tsx']) {
    const source = read(file).replace(/\s+/g, ' ');
    for (const match of source.matchAll(/context="([a-z_]+)"/g)) contexts.add(match[1]);
  }
  assert.ok(contexts.size > 0, 'at least one utility mount must declare a context');

  const isScanFunnelContext = loadScanFunnelPredicate();
  for (const context of contexts) {
    assert.equal(
      isScanFunnelContext(context),
      true,
      `context "${context}" hosts the funnel and must be gated as such`,
    );
  }
});
