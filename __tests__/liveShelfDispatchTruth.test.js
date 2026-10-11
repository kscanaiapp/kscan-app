'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRenderer, createReactNativeStub, deepStub, findAll, readSource, runModule, settle,
} = require('./helpers/componentRenderer');
const { mountUseKScan, detectionPayload } = require('./helpers/scannerHookHarness');

/**
 * The live shelf must not say "Finding where to buy this..." for a search that
 * nothing is running (Production Scanner debugger, P-COM-1).
 *
 * DEFERRED is the one-frame state "the backend announced commerce.deferred and the
 * client is about to dispatch". With the multi-image Scanner on, useKScan holds
 * commerce for a DETECTION result until the user selects a garment, so the shelf
 * stays idle with `deferred` true: DEFERRED never resolved and the detection
 * screen showed a permanent spinner until the user tapped Find Matches, which
 * the screen never said to do. Observed on an Android emulator against the real
 * backend; the flag-ON path was not covered by scanCommerceStateTruth.test.js,
 * which runs the hook with the flag unset.
 */

const COMMERCE_DETECTION_FUNNEL_ON = {
  provider: 'deferred', query: '', count: 0, providersTried: [], catalogCount: 0,
  similarityMatches: 0, commerceSkipped: true, deferred: true, funnelVersion: 'v127',
  reason: 'deferred_to_commerce_only_request',
};

const URI = 'file:///cache/sneaker.jpg';
const PHOTO = { garments: [{ candidateId: 'g1', category: 'footwear', subtype: 'low-top sneaker', label: 'low-top sneaker', color: 'red' }] };

async function detectOnePhoto({ multiImage }) {
  const commerceCalls = [];
  const m = mountUseKScan({
    photos: { [URI]: PHOTO },
    flags: { MULTI_IMAGE_SCANNER_ENABLED: multiImage },
    respond: (request) => (request.mode === 'multi_item_detection' || request.mode === 'legacy'
      ? { data: { ...detectionPayload(PHOTO, request.uri), commerce: COMMERCE_DETECTION_FUNNEL_ON } }
      : undefined),
    stubs: {
      'services/commerceHydration': {
        fetchDeferredCommerce: async () => {
          commerceCalls.push('single');
          return { status: 'error', purchaseOptions: [], enrichmentCandidates: [], retryable: false };
        },
        mergeEnrichedOffers: (current) => current,
      },
      'services/multiItemCommerce': {
        fetchMultiItemCommerce: async () => {
          commerceCalls.push('multi');
          return new Map();
        },
      },
    },
  });
  await m.selectPhotos([{ uri: URI, assetId: 'asset-0', type: 'image' }]);
  await m.analyze();
  await m.idle(10);
  return { m, commerceCalls };
}

function loadSection() {
  const renderer = createRenderer();
  const shelfState = runModule('services/commerceShelfState.ts', {}, { jsx: false });
  const modules = {
    ...renderer.runtimeModules,
    'react-native': createReactNativeStub(),
    '../../constants/theme': { LUXURY: deepStub(), SPACING: deepStub() },
    './PurchaseOptionsPanel': { PurchaseOptionsPanel: 'PurchaseOptionsPanel' },
    '../luxury/InlineNotice': { InlineNotice: 'InlineNotice' },
    './types': { mapRawProductToPurchaseOption: (p, i) => ({ id: `p${i}`, title: p && p.title }) },
    '../../services/commerceShelfState': shelfState,
  };
  const { MultiItemCommerceSection } = runModule('components/scan-results/MultiItemCommerceSection.tsx', modules);
  return { renderer, Section: MultiItemCommerceSection };
}

/** Render the section exactly as ScanResultV2 mounts it and read its notice copy. */
function noticesFor(view, { dispatchHeldForSelection, findMatchesAvailable = true }) {
  const { renderer, Section } = loadSection();
  const analysis = view.analysis || {};
  const tree = renderer.render(renderer.jsx(Section, {
    candidates: analysis.confirmationCandidates || [],
    cardsByCandidateId: new Map((view.multiItemCommerce || []).map((card) => [card.candidateId, card])),
    status: view.multiItemCommerceStatus,
    deferred: Boolean(analysis.commerceDeferred),
    dispatchHeldForSelection,
    findMatchesAvailable,
    onRetry: () => {},
  }));
  return findAll(tree, (node) => node.name === 'InlineNotice').map((node) => String(node.props.body));
}

// ── The premise: with the flag ON, nothing is dispatched for a detection ─────

test('PREMISE (flag ON): a detection result is deferred, the shelf stays idle, and NO commerce request is made', async () => {
  const { m, commerceCalls } = await detectOnePhoto({ multiImage: true });
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.analysis.confirmationCandidates.length, 1);
  assert.equal(Boolean(m.hook.analysis.commerceDeferred), true, 'the backend announced deferral');
  assert.equal(m.hook.multiItemCommerceStatus, 'idle', 'the shelf never leaves idle until a garment is selected');
  assert.equal(m.hook.commerceStatus, 'idle');
  assert.deepEqual(commerceCalls, [], 'no MODE B request for an unselected detection candidate');
  m.unmount();
});

test('CONTROL (flag OFF): the same detection IS dispatched, so DEFERRED is honest there', async () => {
  const { m, commerceCalls } = await detectOnePhoto({ multiImage: false });
  assert.equal(m.hook.status, 'result');
  assert.ok(commerceCalls.length >= 1, 'with the flag off the hook dispatches commerce immediately');
  m.unmount();
});

// ── The screen tells the truth about it ──────────────────────────────────────

test('flag ON: the detection screen says what to do next, never "Finding where to buy this..."', async () => {
  const { m } = await detectOnePhoto({ multiImage: true });
  const notices = noticesFor(m.hook, { dispatchHeldForSelection: true });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Select this item, then tap Find Matches to see where to buy/);
  assert.doesNotMatch(notices[0], /Finding where to buy/);
  m.unmount();
});

test('flag ON, no Find Matches action on the surface: states that matches were not loaded, still not a spinner', async () => {
  const { m } = await detectOnePhoto({ multiImage: true });
  const [notice] = noticesFor(m.hook, { dispatchHeldForSelection: true, findMatchesAvailable: false });
  assert.match(notice, /Shopping matches haven't been loaded for this item/);
  m.unmount();
});

test('flag OFF: an idle deferred frame is still DEFERRED ("Finding where to buy this...")', async () => {
  const { m } = await detectOnePhoto({ multiImage: false });
  // The first committed frame after the deferral, before the dispatch effect ran.
  const idleDeferred = { ...m.hook, multiItemCommerceStatus: 'idle', multiItemCommerce: [] };
  const [notice] = noticesFor(idleDeferred, { dispatchHeldForSelection: false });
  assert.match(notice, /Finding where to buy this/);
  m.unmount();
});

test('NEGATIVE CONTROL: the previous wiring (no hold) renders the false spinner for the flag-ON frame', async () => {
  const { m } = await detectOnePhoto({ multiImage: true });
  const [notice] = noticesFor(m.hook, { dispatchHeldForSelection: false });
  assert.match(notice, /Finding where to buy this/, 'this is the defect the hold removes');
  m.unmount();
});

test('once the user selects and commerce is pending or finished, the hold changes nothing', async () => {
  const { m } = await detectOnePhoto({ multiImage: true });
  const pending = { ...m.hook, multiItemCommerceStatus: 'pending', multiItemCommerce: [] };
  assert.match(noticesFor(pending, { dispatchHeldForSelection: true })[0], /Finding where to buy this/);
  const ready = { ...m.hook, multiItemCommerceStatus: 'ready', multiItemCommerce: [] };
  assert.match(noticesFor(ready, { dispatchHeldForSelection: true })[0], /Couldn't load purchase options/);
  m.unmount();
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('ScanResultV2 holds dispatch when (and only when) the multi-image Scanner is on', () => {
  const source = readSource('components/scan-results/ScanResultV2.tsx');
  assert.match(source, /import \{ MULTI_IMAGE_SCANNER_ENABLED, SCAN_RESULTS_DEMO_UI_ENABLED \} from '\.\.\/\.\.\/constants\/featureFlags';/);
  assert.match(source, /deferred=\{Boolean\(analysis\?\.commerceDeferred\)\}[\s\S]{0,260}dispatchHeldForSelection=\{MULTI_IMAGE_SCANNER_ENABLED\}/);
});

test('the pure predicate: only a deferral that is not held is imminent', () => {
  const { isLiveShelfDispatchImminent } = runModule('services/commerceShelfState.ts', {}, { jsx: false });
  assert.equal(isLiveShelfDispatchImminent({ deferred: true, dispatchHeldForSelection: false }), true);
  assert.equal(isLiveShelfDispatchImminent({ deferred: true, dispatchHeldForSelection: true }), false);
  assert.equal(isLiveShelfDispatchImminent({ deferred: false, dispatchHeldForSelection: false }), false);
  assert.equal(isLiveShelfDispatchImminent({ deferred: false, dispatchHeldForSelection: true }), false);
});

test('settle helper is available (harness sanity)', async () => {
  await settle(1);
});
