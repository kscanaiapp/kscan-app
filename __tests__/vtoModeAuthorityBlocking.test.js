// VTO V2 BLOCKING CONTROLS — BLOCK-VTO2-00 .. BLOCK-VTO2-22.
//
// One file, one purpose: every control the VTO V2 lane may not ship without.
// Where an existing suite already proves a control at its own seam, the test
// here proves it AT THE NEW SEAM (the mode authority, the entry point, the
// result -> Commerce loop) and cites the existing proof rather than copying
// it -- a control asserted twice in two places that can drift is worse than
// one asserted once where the change actually happened.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped: a control must judge code, not prose. */
const code = (rel) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL, URLSearchParams, Math, Number, Set, Map, Object, Array, JSON, Date,
    RangeError, Error, TypeError, String, Boolean, RegExp, Promise,
    __DEV__: false,
    process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const eligibility = loadTsModule('services/vto/vtoEligibility.ts');
const registry = loadTsModule('services/vto/vtoLiveGarmentRegistry.ts');
const liveGarment = loadTsModule('services/vto/vtoLiveGarment.ts', {
  './vtoEligibility': eligibility,
  './vtoLiveGarmentRegistry': registry,
});
const nativeModuleStub = {
  LIVE_VTO_SUPPORTED_PLATFORMS: ['ios', 'android'],
  isLiveVtoNativeCapable: (c) =>
    !!c && c.present === true && c.capable === true && c.runtimeReady === true,
};
const liveCapability = loadTsModule('services/vto/vtoLiveCapability.ts', {
  './liveVtoNativeModule': nativeModuleStub,
});
const authority = loadTsModule('services/vto/vtoModeAuthority.ts', {
  './vtoEligibility': eligibility,
  './vtoLiveGarment': liveGarment,
  './vtoLiveGarmentRegistry': registry,
  './vtoLiveCapability': liveCapability,
  './liveVtoNativeModule': nativeModuleStub,
});
const entryContract = loadTsModule('services/vto/vtoEntryContract.ts', {
  '../../types/vto': {},
  './vtoModeAuthority': authority,
});
const vtoLiveTypes = loadTsModule('types/vtoLive.ts');

const { resolveVtoMode, shouldRenderTryOnAction, VTO_RUNTIME_PROOF } = authority;
const { sessionRefForDecision } = entryContract;

// ── Shared state builders ───────────────────────────────────────────────────

const CAPABLE_NATIVE = {
  present: true, capable: true, runtimeReady: true,
  runtimeVersion: 'test', provenance: 'native', reason: null,
};
const ABSENT_NATIVE = {
  present: false, capable: false, runtimeReady: false,
  runtimeVersion: null, provenance: 'native', reason: 'module_missing',
};

const GOVERNED = registry.LIVE_VTO_GOVERNED_ASSETS[0];

const liveGarmentInput = (overrides = {}) => ({
  productRef: GOVERNED.productRef,
  imageUrl: 'https://cdn.example.com/garments/governed.jpg',
  category: 'top',
  brand: null,
  commerceSource: 'Example Retailer',
  ...overrides,
});

const photoGarmentInput = (overrides = {}) => ({
  productRef: 'prod-dress-0004',
  imageUrl: 'https://cdn.example.com/garments/dress.jpg',
  category: 'Midi Dress',
  brand: null,
  commerceSource: 'Example Retailer',
  ...overrides,
});

const capabilityState = (overrides = {}) => ({
  photoFeatureEnabled: true,
  photoRemoteEnabled: true,
  liveFeatureEnabled: true,
  liveRemoteEnabled: true,
  nativeCapability: CAPABLE_NATIVE,
  cameraPermission: 'granted',
  platformOS: 'ios',
  ...overrides,
});

const entitlementState = (overrides = {}) => ({
  authenticated: true,
  accountActive: true,
  hasEntitlement: true,
  entitlementResolved: true,
  quota: 'unknown',
  ...overrides,
});

const ENTRY = () => code('components/vto/TryItOnEntry.tsx');
const SHEET = () => code('components/vto/VirtualTryOnSheet.tsx');

// ── BLOCK-VTO2-00 — Single eligibility authority ────────────────────────────

test('BLOCK-VTO2-00: exactly one function decides the customer-facing mode', () => {
  // The authority itself.
  assert.equal(typeof resolveVtoMode, 'function');

  // No component may hold a second decision path: not the superseded hooks,
  // not the underlying rule functions, not a flag, not a category list.
  const componentsDir = path.join(ROOT, 'components', 'vto');
  const componentFiles = fs
    .readdirSync(componentsDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => `components/vto/${name}`)
    .concat(['components/ProductShelf.tsx', 'components/scan-results/PurchaseOptionsPanel.tsx']);

  for (const file of componentFiles) {
    const source = code(file);
    for (const forbidden of [
      'useVtoAvailability',
      'useVtoLiveCapability',
      'evaluateVtoEligibility',
      'resolveVtoCapability',
      'LIVE_VTO_ENABLED',
      'DEFAULT_VTO_SUPPORTED_CATEGORIES',
      'DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES',
      'findGovernedLiveAssetByProductRef',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${file} must not re-derive eligibility (${forbidden}) -- ask useVtoMode`,
      );
    }
  }

  // And the entry point asks the one hook.
  assert.match(ENTRY(), /useVtoMode\(\{ garment \}\)/);
});

test('BLOCK-VTO2-00: the authority composes the existing rules rather than restating them', () => {
  // A second copy of the generative rule, the Live asset rule or the Live
  // reason ladder is exactly the drift this lane exists to end.
  const source = code('services/vto/vtoModeAuthority.ts');
  assert.ok(source.includes('evaluateVtoEligibility('), 'the generative rule is CALLED');
  assert.ok(source.includes('resolveLiveGarment('), 'the asset rule is CALLED');
  assert.ok(source.includes('resolveVtoCapability('), 'the Live ladder is CALLED');
  // No re-implementation: no category list, no URL protocol check, no registry
  // scan of its own.
  assert.ok(!/protocol\s*===\s*'https:'/.test(source), 'image safety is not re-implemented');
  assert.ok(!/LIVE_VTO_GOVERNED_ASSETS\s*\./.test(source), 'the registry is not re-scanned');
});

// ── BLOCK-VTO2-01 — the customer surface actually exposes VTO ───────────────

test('BLOCK-VTO2-01: both shipped product surfaces mount the VTO-owned action', () => {
  // eas.json sets EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true in every governed
  // profile, so PurchaseOptionsPanel is what a person actually sees.
  for (const file of [
    'components/scan-results/PurchaseOptionsPanel.tsx',
    'components/ProductShelf.tsx',
  ]) {
    assert.match(code(file), /<TryItOnEntry/, `${file} must mount the VTO action`);
  }
});

test('BLOCK-VTO2-01: an eligible item renders the action, in the mode it will open', () => {
  const live = resolveVtoMode(liveGarmentInput(), capabilityState(), entitlementState());
  assert.equal(live.mode, 'LIVE_LOCAL');
  assert.equal(shouldRenderTryOnAction(live), true);

  const photo = resolveVtoMode(photoGarmentInput(), capabilityState(), entitlementState());
  assert.equal(photo.mode, 'PHOTOREAL_STILL');
  assert.equal(shouldRenderTryOnAction(photo), true);

  // The two must not read identically to a customer (mission section 27).
  const entry = ENTRY();
  assert.match(entry, /LIVE_LOCAL:\s*\{\s*label: 'TRY IT ON'/);
  assert.match(entry, /PHOTOREAL_STILL:\s*\{\s*label: 'TRY IT ON · PHOTO'/);
});

test('BLOCK-VTO2-01: the Live-only operator posture is reachable', () => {
  // THE defect this lane closes. Live enabled, generative operator switch off.
  const decision = resolveVtoMode(
    liveGarmentInput(),
    capabilityState({ photoRemoteEnabled: false }),
    entitlementState(),
  );
  assert.equal(decision.mode, 'LIVE_LOCAL');
  assert.equal(shouldRenderTryOnAction(decision), true);
});

// ── BLOCK-VTO2-02 — no dead action ──────────────────────────────────────────

test('BLOCK-VTO2-02: an unavailable item renders nothing at all', () => {
  const decision = resolveVtoMode(
    photoGarmentInput({ category: 'Leather Sneakers' }),
    capabilityState(),
    entitlementState(),
  );
  assert.equal(decision.mode, 'UNAVAILABLE');
  assert.equal(decision.upgradeOpportunity, false);
  assert.equal(shouldRenderTryOnAction(decision), false);
  assert.match(
    ENTRY(),
    /if \(mode === 'UNAVAILABLE' && !upgradeOpportunity\) return null;/,
  );
  // No disabled/greyed affordance anywhere in the entry point.
  assert.ok(!/disabled=\{/.test(ENTRY()), 'a disabled Try On is still a dead Try On');
});

// ── BLOCK-VTO2-03 / 04 — exact governed asset, never a substitute ───────────

test('BLOCK-VTO2-03: LIVE_LOCAL requires an exact governed asset for THIS productRef', () => {
  const decision = resolveVtoMode(
    liveGarmentInput({ productRef: 'prod-top-not-in-registry' }),
    capabilityState(),
    entitlementState(),
  );
  assert.notEqual(decision.mode, 'LIVE_LOCAL');
  assert.equal(decision.liveReasonCode, 'NO_LIVE_ASSET');

  const eligible = resolveVtoMode(liveGarmentInput(), capabilityState(), entitlementState());
  assert.equal(eligible.mode, 'LIVE_LOCAL');
  assert.equal(eligible.liveAssetKey, GOVERNED.assetKey);
});

test('BLOCK-VTO2-04: no closest / same-category / same-colour substitution', () => {
  // Two governed assets exist. A product that is neither must resolve to
  // NEITHER of them -- not to "the closest one", and not to the first.
  const decision = resolveVtoMode(
    liveGarmentInput({ productRef: 'prod-top-similar-but-different' }),
    capabilityState(),
    entitlementState(),
  );
  assert.equal(decision.liveAssetKey, undefined);
  for (const asset of registry.LIVE_VTO_GOVERNED_ASSETS) {
    assert.notEqual(decision.liveAssetKey, asset.assetKey);
  }
  // Structural: nothing in the resolver ranks, sorts or scores assets.
  const source = code('services/vto/vtoLiveGarmentRegistry.ts');
  assert.match(source, /entry\.productRef === productRef/, 'exact equality, not similarity');
});

// ── BLOCK-VTO2-05 / 06 — item shape ─────────────────────────────────────────

test('BLOCK-VTO2-05: Photo requires a safe verified https garment image', () => {
  for (const imageUrl of [
    '',
    'http://cdn.example.com/g.jpg',
    'data:image/png;base64,iVBORw0KGgo=',
    'file:///tmp/g.jpg',
    'not a url',
  ]) {
    const decision = resolveVtoMode(
      photoGarmentInput({ imageUrl }),
      capabilityState(),
      entitlementState(),
    );
    assert.equal(decision.mode, 'UNAVAILABLE', `must refuse image: ${imageUrl}`);
    assert.equal(decision.reasonCode, 'NO_SAFE_GARMENT_IMAGE');
  }
});

test('BLOCK-VTO2-06: an unknown category cannot be guessed into eligibility', () => {
  for (const category of ['', 'Assorted Homeware Bundle', 'non_fashion', 'widget', null]) {
    const decision = resolveVtoMode(
      photoGarmentInput({ category }),
      capabilityState(),
      entitlementState(),
    );
    assert.equal(decision.mode, 'UNAVAILABLE', `must refuse category: ${String(category)}`);
    assert.equal(decision.reasonCode, 'UNSUPPORTED_CATEGORY');
  }
});

// ── BLOCK-VTO2-07 — entitlement and quota participate ───────────────────────

test('BLOCK-VTO2-07: entitlement gates BOTH modes, and only offers an upgrade when it is the only gap', () => {
  const unentitled = entitlementState({ hasEntitlement: false });

  const live = resolveVtoMode(liveGarmentInput(), capabilityState(), unentitled);
  assert.equal(live.mode, 'UNAVAILABLE');
  assert.equal(live.reasonCode, 'ENTITLEMENT_REQUIRED');
  assert.equal(live.upgradeOpportunity, true);

  const photo = resolveVtoMode(photoGarmentInput(), capabilityState(), unentitled);
  assert.equal(photo.reasonCode, 'ENTITLEMENT_REQUIRED');
  assert.equal(photo.upgradeOpportunity, true);

  // An item that could never be tried on reports ITS OWN blocker, not a
  // paywall: inviting an upgrade for a pair of shoes would be dishonest.
  const shoes = resolveVtoMode(
    photoGarmentInput({ category: 'Leather Sneakers' }),
    capabilityState(),
    unentitled,
  );
  assert.equal(shoes.reasonCode, 'UNSUPPORTED_CATEGORY');
  assert.equal(shoes.upgradeOpportunity, false);

  // A still-loading entitlement is never an upgrade prompt.
  const loading = resolveVtoMode(
    photoGarmentInput(),
    capabilityState(),
    entitlementState({ hasEntitlement: false, entitlementResolved: false }),
  );
  assert.equal(loading.upgradeOpportunity, false);
});

test('BLOCK-VTO2-07: an exhausted quota is refused before the customer enters the flow', () => {
  const decision = resolveVtoMode(
    photoGarmentInput(),
    capabilityState(),
    entitlementState({ quota: 'exhausted' }),
  );
  assert.equal(decision.mode, 'UNAVAILABLE');
  assert.equal(decision.reasonCode, 'QUOTA_EXHAUSTED');

  // Quota constrains the PAID path only. Live costs no provider call and no
  // attempt, so an exhausted quota must not take it away.
  const live = resolveVtoMode(
    liveGarmentInput(),
    capabilityState(),
    entitlementState({ quota: 'exhausted' }),
  );
  assert.equal(live.mode, 'LIVE_LOCAL');
});

test('BLOCK-VTO2-07: an inactive or anonymous actor gets nothing', () => {
  for (const actor of [
    entitlementState({ authenticated: false }),
    entitlementState({ accountActive: false }),
  ]) {
    const decision = resolveVtoMode(liveGarmentInput(), capabilityState(), actor);
    assert.equal(decision.mode, 'UNAVAILABLE');
    assert.equal(decision.reasonCode, 'ACCOUNT_INELIGIBLE');
    assert.equal(decision.upgradeOpportunity, false);
  }
});

// ── BLOCK-VTO2-08 / 09 / 10 / 19 — privacy boundary ─────────────────────────

test('BLOCK-VTO2-08 + 19: no Live frame path reaches a network client', () => {
  // The continuous-frame boundary itself is proven in
  // __tests__/vtoLivePrivacyBoundary.test.js. What is asserted HERE is that
  // the new V2 modules did not open a hole in it.
  for (const file of [
    'services/vto/vtoModeAuthority.ts',
    'services/vto/vtoCapabilityCache.ts',
    'services/vto/vtoEntryContract.ts',
    'services/vto/vtoFunnelTelemetry.ts',
    'hooks/useVtoMode.ts',
    'components/vto/TryItOnEntry.tsx',
  ]) {
    const source = code(file);
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'axios', 'supabase.functions']) {
      assert.ok(!source.includes(forbidden), `${file} must carry no network client (${forbidden})`);
    }
    for (const forbidden of ['frame', 'pixel', 'base64', 'bitmap', 'capturePreview']) {
      assert.ok(
        !source.toLowerCase().includes(forbidden.toLowerCase()),
        `${file} must not touch camera data (${forbidden})`,
      );
    }
  }
});

test('BLOCK-VTO2-09: a photo reaches the backend only after an explicit capture', () => {
  // The refusal ladder lives in services/vto/vtoPhotorealHandoff.ts and is
  // proven in __tests__/vtoLivePhotorealHandoff.test.js. Asserted here: the
  // V2 funnel does not create a second path around it.
  const handoff = code('services/vto/vtoPhotorealHandoff.ts');
  assert.match(handoff, /assertCleanPersonFrame\(frame\)/);
  const sheet = SHEET();
  // The only thing V2 added at this seam is telemetry, and it is emitted
  // INSIDE the existing callback rather than being a new entry to it.
  assert.match(sheet, /onPhotorealPerson: \(person\) => \{[\s\S]{0,400}?vto\.adoptPerson\(person\);/);
});

test('BLOCK-VTO2-10: a composited preview can never become person input', () => {
  const frame = { kind: 'PREVIEW', localUri: 'file:///tmp/x.jpg' };
  assert.throws(() => vtoLiveTypes.assertCleanPersonFrame(frame), RangeError);
  assert.doesNotThrow(() =>
    vtoLiveTypes.assertCleanPersonFrame({ kind: 'PERSON_FRAME', localUri: 'file:///tmp/x.jpg' }));
  // And the refusal is by DECLARED KIND, never by inspecting pixels.
  const handoff = code('services/vto/vtoPhotorealHandoff.ts');
  // Deliberately NOT 'width'/'height': the handoff passes the sanitizer's own
  // reported dimensions through onto the person input, which is metadata about
  // an already-accepted frame, not a test applied to decide whether to accept
  // it. The terms below are the ones that would mean a pixel heuristic.
  for (const heuristic of ['histogram', 'looksLike', 'similarity', 'compare', 'detect']) {
    assert.ok(
      !handoff.toLowerCase().includes(heuristic.toLowerCase()),
      `the clean-frame rule must not use a ${heuristic} heuristic`,
    );
  }
});

// ── BLOCK-VTO2-11 / 12 / 13 / 14 — the result -> Commerce loop ──────────────

test('BLOCK-VTO2-11: Shop from a result uses the injected Commerce destination only', () => {
  const sheet = SHEET();
  const shopBlock = sheet.match(/title="Shop this piece"[\s\S]{0,320}/)[0];
  assert.ok(shopBlock.includes('onShop?.()'), 'the destination is Commerce\'s callback');
  for (const forbidden of ['vto.result', 'vto.garment', 'productUrl', 'price', 'currency', 'retailer']) {
    assert.ok(
      !shopBlock.includes(forbidden),
      `Shop must not reconstruct transaction truth (${forbidden})`,
    );
  }
  // VTO cannot manufacture a Buy action for a browse-only product: the button
  // is disabled precisely when Commerce supplied no destination.
  assert.ok(shopBlock.includes('disabled={!onShop}'));
});

test('BLOCK-VTO2-12: VTO creates no ownership anywhere in the V2 additions', () => {
  for (const file of [
    'services/vto/vtoModeAuthority.ts',
    'services/vto/vtoEntryContract.ts',
    'services/vto/vtoFunnelTelemetry.ts',
    'services/vto/vtoCapabilityCache.ts',
    'hooks/useVtoMode.ts',
    'components/vto/TryItOnEntry.tsx',
  ]) {
    const source = code(file);
    for (const forbidden of [
      'ownedCloset', 'closetLibrary', 'closetMedia', 'addToCloset', 'purchase',
      'acquire', 'styleMemoryEvents', 'signatureStyle',
    ]) {
      assert.ok(
        !source.toLowerCase().includes(forbidden.toLowerCase()),
        `${file} must not create ownership (${forbidden})`,
      );
    }
  }
});

test('BLOCK-VTO2-13: Save from a result reuses the existing Dressing Room path', () => {
  assert.match(SHEET(), /<VtoSaveToDressingRoom/);
  assert.match(
    code('components/vto/VtoSaveToDressingRoom.tsx'),
    /AddScanToDressingRoomModal/,
    'the existing save surface, not a VTO-specific one',
  );
  // The sheet itself still holds zero persistence imports.
  assert.ok(!SHEET().includes('AddScanToDressingRoomModal'));
});

test('BLOCK-VTO2-14: Watch from a result reuses the existing governed Watchlist path', () => {
  const sheet = SHEET();
  // The action exists, is opt-in, and calls the injected callback only.
  assert.match(sheet, /title="Watch this piece"/);
  assert.match(sheet, /\{onWatch \?/, 'no Watch action when the surface has none');
  const watchBlock = sheet.match(/title="Watch this piece"[\s\S]{0,320}/)[0];
  assert.ok(watchBlock.includes('onWatch()'));
  for (const forbidden of ['createWatch', 'watchlistClient', 'watchCapability', 'supabase']) {
    assert.ok(!watchBlock.includes(forbidden), `VTO must not create a watch (${forbidden})`);
  }
  // Both product surfaces pass their OWN existing candidate and modal, gated
  // by their OWN existing server-authored eligibility.
  const panel = code('components/scan-results/PurchaseOptionsPanel.tsx');
  assert.match(panel, /onWatch=\{\s*canWatch\s*\?[\s\S]{0,120}setWatchCandidate\(option\.watchCandidate/);
  assert.match(panel, /<WatchThisModal/);
  const shelf = code('components/ProductShelf.tsx');
  assert.match(shelf, /onWatch=\{canWatch \? \(\) => setWatchModalProduct\(p\) : undefined\}/);
  // And no VTO module learned what a watch is.
  for (const file of [
    'services/vto/vtoModeAuthority.ts',
    'services/vto/vtoEntryContract.ts',
    'components/vto/TryItOnEntry.tsx',
  ]) {
    assert.ok(
      !code(file).includes('watchCandidate'),
      `${file} must not understand a watch candidate`,
    );
  }
});

// ── BLOCK-VTO2-15 — stale product / mode completion ─────────────────────────

test('BLOCK-VTO2-15: a decision about another product cannot start this one', () => {
  const productA = liveGarmentInput();
  const productB = photoGarmentInput();
  const decisionA = resolveVtoMode(productA, capabilityState(), entitlementState());

  // A stale decision carried over from product A is REFUSED for product B --
  // structurally, before any session exists to supersede.
  const outcome = sessionRefForDecision(productB, decisionA, 'commerce_product');
  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, 'product_reference_invalid');

  const ok = sessionRefForDecision(productA, decisionA, 'commerce_product');
  assert.equal(ok.started, true);
  assert.equal(ok.session.productRef, productA.productRef);
  assert.equal(ok.session.mode, 'LIVE_LOCAL');

  // The existing supersede/lifecycle proof (#334) is unchanged and lives in
  // __tests__/vtoRequestLifecycle.test.js and vtoLiveSessionConcurrency.test.js.
  assert.match(code('services/vto/vtoRequestStore.ts'), /vto_request_superseded/);
});

test('BLOCK-VTO2-15: an UNAVAILABLE decision can never start a session', () => {
  const shoes = photoGarmentInput({ category: 'Leather Sneakers' });
  const decision = resolveVtoMode(shoes, capabilityState(), entitlementState());
  const outcome = sessionRefForDecision(shoes, decision, 'commerce_product');
  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, 'mode_unavailable');
});

// ── BLOCK-VTO2-16 — provider failure is not product truth ───────────────────

test('BLOCK-VTO2-16: a provider failure is never converted into an unsupported item', () => {
  const failures = loadTsModule('services/vto/vtoFailures.ts', {
    '../../types/vto': loadTsModule('types/vto.ts'),
  });
  const providerish = ['provider_unavailable', 'provider_timeout', 'generation_failed', 'rate_limited'];
  for (const code_ of providerish) {
    const failure = failures.toVtoFailure(code_);
    assert.doesNotMatch(
      failure.message,
      /isn't available for this item/i,
      `${code_} must not read as an unsupported product`,
    );
  }
  // And the unsupported copy is reserved for the genuinely unsupported.
  assert.match(failures.toVtoFailure('unsupported_category').message, /isn't available for this item/i);

  // The mode authority has no provider vocabulary at all, so a provider
  // outcome cannot reach it and become a coverage verdict.
  const source = code('services/vto/vtoModeAuthority.ts');
  for (const forbidden of ['provider', 'http', '429', 'timeout']) {
    assert.ok(
      !source.toLowerCase().includes(forbidden),
      `the mode authority must not know about ${forbidden}`,
    );
  }
});

// ── BLOCK-VTO2-17 — actor isolation ─────────────────────────────────────────

test('BLOCK-VTO2-17: no V2 module holds actor-scoped state across actors', () => {
  // The capability cache is the only new module-scoped state, and it holds a
  // DEVICE answer -- nothing actor-scoped, nothing persisted.
  const cache = code('services/vto/vtoCapabilityCache.ts');
  for (const forbidden of ['AsyncStorage', 'SecureStore', 'FileSystem', 'userId', 'actor', 'uid']) {
    assert.ok(
      !cache.toLowerCase().includes(forbidden.toLowerCase()),
      `the capability cache must hold no ${forbidden}`,
    );
  }
  assert.match(cache, /export function resetLiveVtoCapabilityCache/);

  // The decision itself is a pure function of its inputs: two different actor
  // states over the same product give two different answers with no carryover.
  const product = photoGarmentInput();
  const entitled = resolveVtoMode(product, capabilityState(), entitlementState());
  const anonymous = resolveVtoMode(product, capabilityState(), entitlementState({ authenticated: false }));
  const entitledAgain = resolveVtoMode(product, capabilityState(), entitlementState());
  assert.equal(entitled.mode, 'PHOTOREAL_STILL');
  assert.equal(anonymous.mode, 'UNAVAILABLE');
  assert.deepEqual(entitledAgain.mode, entitled.mode);

  // The existing actor-boundary reset is untouched.
  assert.match(
    read('contexts/AuthSessionContext.tsx'),
    /resetVtoRequestState/,
    'the actor boundary still resets VTO state',
  );
});

// ── BLOCK-VTO2-18 — no new provider or model ────────────────────────────────

test('BLOCK-VTO2-18: no provider, model or credential was added', () => {
  const providerDir = path.join(ROOT, 'supabase/functions/vto-generate/providers');
  const providers = fs.readdirSync(providerDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
  assert.deepEqual(
    providers.sort(),
    ['aiLabToolsProvider.ts', 'index.ts', 'mockProvider.ts', 'mockResultAsset.ts'],
    'the provider set is unchanged',
  );
  for (const file of [
    'services/vto/vtoModeAuthority.ts',
    'services/vto/vtoEntryContract.ts',
    'services/vto/vtoFunnelTelemetry.ts',
    'services/vto/vtoCapabilityCache.ts',
    'hooks/useVtoMode.ts',
  ]) {
    const source = read(file);
    for (const pattern of [/RAPIDAPI/i, /api[_-]?key/i, /\.p\.rapidapi\.com/i, /Bearer /]) {
      assert.ok(!pattern.test(source), `${file} must not carry ${pattern}`);
    }
  }
  // The on-device model registry is unchanged by this lane.
  const models = JSON.parse(read('config/on-device-model-authority.json'));
  assert.ok(models, 'the governed model registry still parses');
});

// ── BLOCK-VTO2-20 — no body or fit profile ──────────────────────────────────

test('BLOCK-VTO2-20: no V2 module infers anything about the body', () => {
  for (const file of [
    'services/vto/vtoModeAuthority.ts',
    'services/vto/vtoEntryContract.ts',
    'services/vto/vtoFunnelTelemetry.ts',
    'services/vto/vtoCapabilityCache.ts',
    'hooks/useVtoMode.ts',
    'components/vto/TryItOnEntry.tsx',
  ]) {
    const source = code(file).toLowerCase();
    for (const term of [
      'bmi', 'bodyfat', 'body_fat', 'bodyheight', 'bodyweight', 'measurement',
      'bodyscan', 'body_scan', 'fitscore', 'fit_score', 'sizerecommendation',
      'recommendedsize', 'chest', 'waist', 'inseam', 'proportions',
    ]) {
      assert.ok(!source.includes(term), `${file} must not mention ${term}`);
    }
    // `height`/`weight` are excluded from the list above ONLY because a
    // stylesheet legitimately carries `minHeight` and `fontWeight`. They are
    // still refused outside a StyleSheet block, so a body dimension cannot
    // hide behind a layout word.
    const withoutStyles = source.replace(/stylesheet\.create\([\s\S]*$/, '');
    for (const term of ['height', 'weight']) {
      assert.ok(!withoutStyles.includes(term), `${file} must not mention ${term}`);
    }
  }
});

// ── BLOCK-VTO2-21 — the Commerce V2 boundary ────────────────────────────────

test('BLOCK-VTO2-21: no Commerce ranking, shelf memory or Elise state was touched', () => {
  // The two shared files this lane edits are edited ADDITIVELY, and the edit
  // is one prop. Nothing about ordering, scoring, candidate selection or
  // conversational state is reachable from a VTO module.
  for (const file of [
    'services/vto/vtoModeAuthority.ts',
    'services/vto/vtoEntryContract.ts',
    'hooks/useVtoMode.ts',
    'components/vto/TryItOnEntry.tsx',
  ]) {
    const source = code(file);
    for (const forbidden of [
      'commerceRank', 'shelfMemory', 'eliseAction', 'conversationReducer',
      'contextualCommerce', 'scoreCandidate', 'signatureStyle', 'packing',
    ]) {
      assert.ok(
        !source.toLowerCase().includes(forbidden.toLowerCase()),
        `${file} must not reach Commerce V2 state (${forbidden})`,
      );
    }
  }
  // The VTO seam in the shared surfaces is a mount plus opaque callbacks.
  const panel = code('components/scan-results/PurchaseOptionsPanel.tsx');
  assert.ok(!panel.includes('useVtoMode'), 'eligibility stays inside the VTO component');
  assert.ok(!panel.includes('resolveVtoMode'), 'eligibility stays inside the VTO component');
  assert.ok(!panel.includes('VirtualTryOnSheet'), 'the sheet belongs to TryItOnEntry');
});

// ── BLOCK-VTO2-22 — telemetry boundary ──────────────────────────────────────

test('BLOCK-VTO2-22: the funnel can emit only bounded enums', () => {
  const telemetry = loadTsModule('services/vto/vtoTelemetry.ts');
  const funnel = loadTsModule('services/vto/vtoFunnelTelemetry.ts', {
    './vtoTelemetry': telemetry,
    './vtoModeAuthority': authority,
    '../../types/vto': {},
  });

  const captured = [];
  telemetry.setVtoAnalyticsSink((event, payload) => captured.push({ event, payload }));

  const decision = resolveVtoMode(
    photoGarmentInput({ imageUrl: 'https://cdn.example.com/secret-image-name.jpg' }),
    capabilityState(),
    entitlementState(),
  );
  funnel.emitVtoModeResolved(decision, 'commerce_product');
  funnel.emitVtoEntryShown(decision, 'commerce_product');
  funnel.emitVtoEntryUnavailable(decision, 'commerce_product');
  funnel.emitVtoCaptureCompleted('commerce_product');
  funnel.emitVtoHandoffReady('commerce_product', true);
  funnel.emitVtoResultShop('commerce_product', 'ai_photo');
  funnel.emitVtoResultWatch('commerce_product', 'live');
  telemetry.resetVtoAnalyticsSink();

  assert.equal(captured.length, 7, 'every funnel event reached the governed sink');

  const serialized = JSON.stringify(captured);
  for (const leak of [
    'prod-dress-0004', 'secret-image-name', 'https://', 'cdn.example.com',
    'Example Retailer', 'Midi Dress', 'file://', 'base64',
  ]) {
    assert.ok(!serialized.includes(leak), `the funnel leaked ${leak}`);
  }

  // Every emitted property is on the governed allowlist, and every value is a
  // short enum token or a number.
  for (const { event, payload } of captured) {
    assert.ok(telemetry.VTO_EVENTS.includes(event), `${event} is not a registered event`);
    for (const [key, value] of Object.entries(payload)) {
      assert.ok(telemetry.VTO_EVENT_PROPERTIES.includes(key), `${key} is not an allowed property`);
      if (value === null) continue;
      assert.ok(
        typeof value === 'number' || /^[a-z0-9_.:-]{1,64}$/.test(String(value)),
        `${event}.${key} is not a bounded token: ${String(value)}`,
      );
    }
  }
});

test('BLOCK-VTO2-22: an unknown event or property is dropped, not passed through', () => {
  const telemetry = loadTsModule('services/vto/vtoTelemetry.ts');
  const captured = [];
  telemetry.setVtoAnalyticsSink((event, payload) => captured.push({ event, payload }));
  telemetry.emitVtoEvent('vto_made_up_event', { origin: 'commerce_product' });
  telemetry.emitVtoEvent('vto_mode_resolved', {
    origin: 'commerce_product',
    productTitle: 'Midi Dress by Example Brand',
    imageUrl: 'https://cdn.example.com/x.jpg',
    reasonCode: 'unsupported_category',
  });
  telemetry.resetVtoAnalyticsSink();
  assert.equal(captured.length, 1, 'the unregistered event was dropped');
  // Serialized rather than compared by reference: the payload object is
  // created inside the module sandbox, so it has a different Object prototype.
  assert.equal(
    JSON.stringify(captured[0].payload),
    JSON.stringify({ origin: 'commerce_product', reasonCode: 'unsupported_category' }),
  );
});

// ── Runtime-proof honesty ───────────────────────────────────────────────────

test('neither mode claims proven runtime coverage', () => {
  assert.equal(VTO_RUNTIME_PROOF.LIVE_LOCAL, 'SOURCE_CONNECTED_RUNTIME_UNPROVEN');
  assert.equal(VTO_RUNTIME_PROOF.PHOTOREAL_STILL, 'SOURCE_CONNECTED_RUNTIME_UNPROVEN');
  const live = resolveVtoMode(liveGarmentInput(), capabilityState(), entitlementState());
  const photo = resolveVtoMode(photoGarmentInput(), capabilityState(), entitlementState());
  assert.equal(live.status, 'SOURCE_CONNECTED_RUNTIME_UNPROVEN');
  assert.equal(photo.status, 'SOURCE_CONNECTED_RUNTIME_UNPROVEN');
});
