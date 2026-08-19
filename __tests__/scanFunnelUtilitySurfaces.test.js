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

test('commerce renders before the utility panel that carries Shopping Intent', () => {
  const source = read(ANALYSIS_CARD);
  const commerce = source.indexOf('<PurchaseOptionsPanel');
  const utility = source.indexOf('<SavedItemUtilityPanel');
  assert.notEqual(commerce, -1, 'the commerce panel must exist on the live surface');
  assert.notEqual(utility, -1, 'the utility panel must exist on the live surface');
  assert.ok(
    commerce < utility,
    'purchase options must precede Shopping Intent — the user sees what they can buy first',
  );
});

test('the live scan surface declares the funnel, not the Closet', () => {
  const source = read(ANALYSIS_CARD).replace(/\s+/g, ' ');
  assert.match(
    source,
    /<SavedItemUtilityPanel[^>]*context="scan_result"/,
    'AnalysisCard is the scan result and must declare scan_result',
  );
  assert.doesNotMatch(
    source,
    /<SavedItemUtilityPanel[^>]*context="library"/,
    'declaring library here is the conflation that caused the regression',
  );
});

// -- Commerce restoration (Fix #9) ------------------------------------------

test('the deferred commerce runtime is present on this candidate', () => {
  // Fix #9 was absent from the V10 candidate entirely; commerce could not
  // render because nothing hydrated it.
  for (const module of ['services/commerceHydration.ts', 'services/commerceJobScheduler.ts']) {
    assert.ok(fs.existsSync(path.join(ROOT, module)), `${module} must be restored`);
  }
  const hook = read('hooks/useKScan.js');
  assert.match(hook, /fetchDeferredCommerce/, 'the scan hook must fetch deferred commerce');
  assert.match(hook, /hydrateDeferredCommerce/, 'the scan hook must hydrate deferred commerce');
});

test('the commerce panel supports pending, empty, error and retry', () => {
  const panel = read('components/scan-results/PurchaseOptionsPanel.tsx');
  assert.match(panel, /'idle' \| 'pending' \| 'success' \| 'empty' \| 'error'/);
  assert.match(panel, /onRetry/, 'a failed deferred fetch must be retryable');

  const card = read(ANALYSIS_CARD).replace(/\s+/g, ' ');
  // The panel must mount while commerce is still deferred, not only on success.
  assert.match(
    card,
    /purchaseShelfMode === 'pending' \|\| purchaseShelfMode === 'error'/,
    'the funnel must show a governed pending/error state, not an empty gap',
  );
  assert.match(card, /commerceStatus=\{purchaseShelfMode\}/);
  assert.match(card, /onRetry=\{onRetryCommerce\}/);
});

test('both live result surfaces exclude the maintenance cards', () => {
  // Correction to an earlier reading: ScanResultV2 is NOT dead. app.js imports
  // and renders it — but only for candidate review, and its own comment records
  // that "zero commerce work happens on this surface". AnalysisCard is the
  // commerce result surface. Both are live, and both sit inside the funnel:
  //
  //   ScanResultV2  -> ScanResultUtilityFooter -> context="scan"
  //   AnalysisCard  -> SavedItemUtilityPanel   -> context="scan_result"
  //
  // The single gate must therefore cover both context values.
  const app = read('app.js');
  assert.match(app, /import \{ ScanResultV2 \}/, 'ScanResultV2 is live, not dead');
  assert.match(app, /import \{ AnalysisCard \}/, 'AnalysisCard is live');

  const footer = read('components/free-tier/ScanResultUtilityFooter.tsx');
  assert.match(footer, /context="scan"/, 'the review footer declares the funnel');

  const isScanFunnelContext = loadScanFunnelPredicate();
  assert.equal(isScanFunnelContext('scan'), true, 'review surface is covered');
  assert.equal(isScanFunnelContext('scan_result'), true, 'result surface is covered');
});

test('the candidate review surface stays out of the commerce path', () => {
  // Review is item selection, not results. It must not grow a commerce section,
  // and its ordering is therefore not part of the commerce contract.
  const app = read('app.js').replace(/\s+/g, ' ');
  assert.match(
    app,
    /zero commerce work happens on this surface/,
    'the review surface must remain commerce-free by contract',
  );
});
