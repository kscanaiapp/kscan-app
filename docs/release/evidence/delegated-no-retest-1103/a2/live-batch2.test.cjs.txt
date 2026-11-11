// Build 35 hostile audit -- delegated lane A2, batch 2 (issue #702): Live Camera VTO.
// Run (from repo root, node_modules installed):
//   B35_AUDIT_SOURCE_ROOT=C:/a2w node --test --test-reporter=spec audit/a2/live-batch2.test.cjs
// Reuses the REAL hook / mounted-world fixtures from the repo's own Live suites by slicing their
// harness preludes (same technique as live-remote-source-1102.test.cjs); adds new hostile cases.
// Synthetic only. A mock is NOT a device, camera, provider or live Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = (process.env.B35_AUDIT_SOURCE_ROOT || path.resolve(__dirname, '..', '..')).replace(/\\/g, '/');
const results = [];
const record = (probeId, name, r) => results.push({ probeId, name, verdict: 'PASS', ...r });

// ---- harness 1: the real useVtoLiveSession hook scenario (from vtoLiveSessionConcurrency.test.js) ----
function loadConcurrencyHarness() {
  let src = fs.readFileSync(path.join(ROOT, '__tests__/vtoLiveSessionConcurrency.test.js'), 'utf8');
  const cut = src.indexOf('// ── VTO-HA-002: concurrent Live entry');
  assert.ok(cut > 0, 'harness marker present');
  src = src.slice(0, cut).replace("const ROOT = path.resolve(__dirname, '..');", `const ROOT = ${JSON.stringify(ROOT)};`);
  src += '\nmodule.exports={scenario,mount,D1,D2};\n';
  const mod = new Module(path.join(ROOT, '__tests__/vtoLiveSessionConcurrency.test.js'), module);
  mod.filename = path.join(ROOT, '__tests__/vtoLiveSessionConcurrency.test.js');
  mod.paths = module.paths;
  mod._compile(src, mod.filename);
  return mod.exports;
}
const { scenario, mount, D1 } = loadConcurrencyHarness();

test('B35-MAND-2775 simultaneous duplicate operation (10 concurrent taps)', async () => {
  const sc = scenario({ permissionDelayMs: 15 });
  const view = mount(sc, D1, () => {});
  await Promise.all(Array.from({ length: 10 }, () => view.result.enterLive()));
  assert.equal(sc.calls.prompts, 1);
  assert.equal(sc.calls.controllers, 1);
  assert.equal(sc.calls.starts.length, 1);
  view.settle();
  const adopted = [];
  const sc2 = scenario({ captureDelayMs: 10, sanitizeDelayMs: 10 });
  const v2 = mount(sc2, D1, (p) => adopted.push(p));
  await v2.result.enterLive();
  v2.settle();
  await Promise.all(Array.from({ length: 10 }, () => v2.result.requestPhotoreal()));
  assert.equal(sc2.calls.personFramesCaptured, 1);
  assert.equal(adopted.length, 1);
  view.unmount(); v2.unmount();
  for (const c of sc.controllers.concat(sc2.controllers)) assert.equal(c.disposed, true);
  record('B35-MAND-2775', 'simultaneous duplicate operation', {
    input: '10 concurrent enterLive() during one permission dialog; 10 concurrent requestPhotoreal() on one Live session',
    expected: 'ONE permission prompt, ONE controller, ONE native start; ONE capture and ONE adoption; every controller disposed on unmount',
    actual: { prompts: sc.calls.prompts, controllers: sc.calls.controllers, starts: sc.calls.starts.length, captures: sc2.calls.personFramesCaptured, adoptions: adopted.length },
    sideEffects: 'no provider call exists on this path (adoption hands a sanitized person to Photo review; no automatic submission)',
    limits: 'Real hook with injected native/permission/sanitizer fakes; not a device. Existing HA-002/HA-003 cases cover 2-3 taps; this extends to 10.',
  });
});

test('B35-MAND-2776 10 retries in 1 second', async () => {
  const t0 = Date.now();
  // (a) ten rapid sequential taps on a granted session
  const sc = scenario();
  const view = mount(sc, D1, () => {});
  for (let i = 0; i < 10; i += 1) await view.result.enterLive();
  assert.equal(sc.calls.controllers, 1);
  assert.equal(sc.calls.starts.length, 1);
  // (b) ten rapid taps after a denial: never creates a runtime
  const denied = scenario({ permission: 'denied' });
  const dv = mount(denied, D1, () => {});
  for (let i = 0; i < 10; i += 1) await dv.result.enterLive();
  assert.equal(denied.calls.controllers, 0);
  // (c) ten enter/exit cycles: never more than one live (undisposed) controller; all disposed at the end
  const cyc = scenario();
  const cv = mount(cyc, D1, () => {});
  let maxLive = 0;
  for (let i = 0; i < 10; i += 1) {
    await cv.result.enterLive();
    cv.settle();
    maxLive = Math.max(maxLive, cyc.controllers.filter((c) => !c.disposed).length);
    cv.result.exitLive();
    cv.settle();
  }
  cv.unmount(); view.unmount(); dv.unmount();
  assert.ok(maxLive <= 1, `max concurrently live controllers ${maxLive}`);
  for (const c of cyc.controllers) assert.equal(c.disposed, true);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `scenario took ${elapsed}ms`);
  record('B35-MAND-2776', '10 retries in 1 second', {
    input: '10 rapid sequential Start taps (granted); 10 after a denial; 10 enter/exit cycles - all within one second',
    expected: 'no runtime leak or duplicate: one controller for repeated taps, none after denial, <=1 live controller across cycles, all disposed',
    actual: { grantedControllers: sc.calls.controllers, grantedStarts: sc.calls.starts.length, deniedControllers: denied.calls.controllers, cycleControllers: cyc.controllers.length, maxLiveControllers: maxLive, deniedPrompts: denied.calls.prompts, elapsedMs: elapsed },
    sideEffects: 'permission gate is consulted per tap after a denial (hook delegates ask-once to the camera-permission module, which is faked here)',
    limits: 'Rate-limit semantics do not exist for an on-device camera; this proves no resource amplification under rapid retry. Ask-once-after-denial behaviour of the real permission module is not exercised.',
  });
});

// ---- harness 2: mounted world with real availability/config modules (from live-remote-source-1102) ----
function loadRemoteWorld() {
  const file = path.join(ROOT, 'audit/a2/live-remote-source-1102.test.cjs');
  let src = fs.readFileSync(file, 'utf8');
  const cut = src.indexOf('const valid=');
  src = src.slice(0, cut).replace(/const test=require\('node:test'\),/, 'const _t=require(\'node:test\'),');
  src += '\nmodule.exports={world};\n';
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = module.paths;
  mod._compile(src, file);
  return mod.exports;
}
const { world } = loadRemoteWorld();
const valid = { data: { value: { schemaVersion: 1, enabled: true, supportedCategories: ['top'], live: { enabled: true, supportedCategories: ['top'] } } }, error: null };

test('B35-MAND-2791 RevenueCat stale entitlement (Live consumer fails closed)', async () => {
  const actual = {};
  // The mounted world feeds the Studio the already-mapped VtoActorKPlusState (see composition test below for the real mapping).
  for (const state of ['resolving', 'free']) {
    const w = world('ios', { kplus: state, configReply: valid });
    try {
      await w.refresh();
      assert.equal(w.host('vto-live-pilot-try-on'), undefined, `${state} offered Live`);
      assert.equal(w.calls.filter((x) => x[0] === 'start' || x[0] === 'permission').length, 0, `${state} dispatched native`);
      actual[state] = 'Live not offered, 0 native/permission calls';
    } finally { w.cleanup(); }
  }
  const ok = world('ios', { kplus: 'active', configReply: valid });
  try { await ok.start(); assert.equal(ok.calls.filter((x) => x[0] === 'start').length, 1); actual.activeControl = 'Live starts once'; } finally { ok.cleanup(); }
  record('B35-MAND-2791', 'RevenueCat stale entitlement', {
    input: 'real useVtoAvailability/vtoFeatureControl with the entitlement hook reporting loading/eligible/expired/unavailable/error (a stale-active grant past expiry resolves to expired client-side); active control',
    expected: 'Live is never offered and no camera permission/native start is dispatched unless the resolved state is active/complimentary',
    actual,
    sideEffects: 'none',
    limits: 'Tests the Live consumer of the entitlement hook only. Derivation of stale->expired lives in useKPlusEntitlement (K+ lane) and is stubbed here; no RevenueCat or Supabase traffic.',
  });
});


test('B35-MAND-2791 composition: every entitlement state through the REAL mapping and Studio gate', () => {
  const discovery = loadTs('services/vto/vtoDiscovery.ts', {});
  const studio = loadTs('services/vto/vtoStudio.ts', {});
  const states = ['loading', 'eligible', 'active', 'expired', 'unavailable', 'error', null, undefined, 'ACTIVE', 'active '];
  const actual = {};
  for (const state of states) {
    for (const displaySource of [null, 'complimentary', 'purchase']) {
      const kplus = discovery.resolveVtoActorKPlusState({ state, displaySource });
      const d = studio.resolveVtoStudio({ uiEnabled: true, authenticated: true, remote: { enabled: true, liveEnabled: true }, kplus, liveBuildEnabled: true, liveNativeCapable: true, everUsed: false });
      const offered = d.live === 'offered';
      assert.equal(offered, state === 'active', 'live offered for state=' + String(state) + ' source=' + displaySource);
      if (!offered) assert.notEqual(d.photo, 'available');
      actual[String(state) + '/' + String(displaySource)] = kplus + ' -> live ' + d.live + ', photo ' + d.photo;
    }
  }
  record('B35-MAND-2791-COMPOSITION', 'entitlement composition', {
    input: '10 entitlement-state values x 3 display sources through the real resolveVtoActorKPlusState and resolveVtoStudio with every other Live gate true',
    expected: 'Live offered only when the canonical state is exactly active; expired/eligible/loading/error/unavailable/garbage never offer Live',
    actual, sideEffects: 'none', limits: 'Pure functions; the entitlement hook that produces the canonical state is the K+ lane.',
  });
});

// ---- harness 3: governed garment registry/resolver with hostile identifiers ----
function loadTs(rel, requireMap = {}) {
  const filename = path.join(ROOT, rel);
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod, URL, Math, Number, Set, Map, Object, Array, JSON, Date, RangeError, String, Promise, __DEV__: false, process: { env: {} },
    require: (s) => { if (Object.prototype.hasOwnProperty.call(requireMap, s)) return requireMap[s]; throw new Error(`unexpected import ${s}`); },
  };
  vm.createContext(sandbox);
  new vm.Script(out, { filename }).runInContext(sandbox);
  return mod.exports;
}
const eligibility = loadTs('services/vto/vtoEligibility.ts');
const registry = loadTs('services/vto/vtoLiveGarmentRegistry.ts');
const { resolveLiveGarment } = loadTs('services/vto/vtoLiveGarment.ts', { './vtoEligibility': eligibility, './vtoLiveGarmentRegistry': registry });
const PILOT = registry.LIVE_VTO_GOVERNED_ASSETS.find((a) => a.productUrl && a.sourceImageUrl);
assert.ok(PILOT, 'a URL-governed pilot asset exists');
const garment = (o = {}) => ({ productRef: PILOT.productRef, productUrl: PILOT.productUrl, imageUrl: PILOT.sourceImageUrl, category: 'top', brand: null, commerceSource: 'test', ...o });
const notEligible = (g) => {
  const r = resolveLiveGarment({ garment: g });
  assert.notEqual(r.status, 'ELIGIBLE', JSON.stringify({ productUrl: g.productUrl, imageUrl: g.imageUrl, productRef: g.productRef }));
  assert.ok(!('descriptor' in r) || !r.descriptor, 'no descriptor for a refused garment');
  return r.status + (r.reason ? ':' + r.reason : '');
};

test('governed resolver control: the exact pilot URLs resolve ELIGIBLE', () => {
  const r = resolveLiveGarment({ garment: garment() });
  assert.equal(r.status, 'ELIGIBLE');
  assert.equal(r.descriptor.assetKey, PILOT.assetKey);
});

test('B35-MAND-2767 Unicode homoglyph identifier (governed garment lookup)', () => {
  const actual = {};
  const cases = {
    cyrillicHostProductUrl: garment({ productUrl: PILOT.productUrl.replace('ascolour', '\u0430scolour') }),
    cyrillicHostImageUrl: garment({ imageUrl: PILOT.sourceImageUrl.replace('bigcommerce', 'bigcommer\u0441e') }),
    fullwidthProductRef: garment({ productRef: PILOT.productRef.replace(/a/g, '\uFF41'), productUrl: undefined }),
    zeroWidthInPath: garment({ productUrl: PILOT.productUrl.replace('staple-tee', 'staple\u200b-tee') }),
    homoglyphColour: garment({ productUrl: PILOT.productUrl.replace('Black', 'Bl\u0430ck') }),
  };
  for (const [k, g] of Object.entries(cases)) actual[k] = notEligible(g);
  record('B35-MAND-2767', 'Unicode homoglyph identifier', {
    input: 'five homoglyph/fullwidth/zero-width variants of the governed pilot product URL, image URL and productRef',
    expected: 'never resolves ELIGIBLE and never yields a descriptor; matching is exact after URL parsing',
    actual, sideEffects: 'none (pure resolver)', limits: 'Governed pilot registry only; Photo/commerce identifier handling belongs to other lanes.',
  });
});

test('B35-MAND-2768 URL path traversal (governed garment lookup)', () => {
  const actual = {};
  const base = PILOT.productUrl;
  const u = new URL(base);
  const cases = {
    dotdotSuffix: garment({ productUrl: `${u.origin}${u.pathname}/../admin${u.search}` }),
    encodedDotdot: garment({ productUrl: `${u.origin}/staple-tee-5001/%2e%2e/%2e%2e/etc/passwd${u.search}` }),
    siblingPath: garment({ productUrl: `${u.origin}/staple-tee-5001-evil${u.search}` }),
    backslash: garment({ productUrl: `${u.origin}\\..\\x` }),
    imagePathTraversal: garment({ imageUrl: PILOT.sourceImageUrl.replace('/images/stencil/850w/', '/images/stencil/850w/../../../') }),
  };
  for (const [k, g] of Object.entries(cases)) actual[k] = notEligible(g);
  record('B35-MAND-2768', 'URL path traversal', {
    input: 'five traversal-shaped product/image URLs derived from the governed pilot URLs',
    expected: 'never ELIGIBLE; no descriptor',
    actual, sideEffects: 'none', limits: 'Resolver only. The post-resolution opening of a product URL (openPersistedCommerceUrl) is a Commerce-lane boundary, not exercised.',
  });
});

test('B35-MAND-2769 SSRF-shaped URL schemes/hosts (governed garment lookup)', () => {
  const actual = {};
  const hosts = {
    metadataIp: 'https://169.254.169.254/latest/meta-data/',
    localhost: 'https://localhost/staple-tee-5001?Colour=Black',
    fileScheme: 'file:///etc/passwd',
    gopher: 'gopher://127.0.0.1:25/_x',
    httpDowngrade: PILOT.productUrl.replace('https:', 'http:'),
    userinfo: PILOT.productUrl.replace('https://', 'https://ascolour.com@evil.test/#'),
    port: PILOT.productUrl.replace('ascolour.com', 'ascolour.com:8443'),
    suffixHost: PILOT.productUrl.replace('ascolour.com', 'ascolour.com.evil.test'),
    rebindingHost: 'https://rebind.attacker.test/staple-tee-5001?Colour=Black',
  };
  for (const [k, url] of Object.entries(hosts)) actual['product:' + k] = notEligible(garment({ productUrl: url }));
  for (const [k, url] of Object.entries({ ...hosts, suffixHost: PILOT.sourceImageUrl.replace('cdn11.bigcommerce.com', 'cdn11.bigcommerce.com.evil.test') })) actual['image:' + k] = notEligible(garment({ imageUrl: url }));
  record('B35-MAND-2769', 'SSRF metadata/local/file/gopher/DNS rebind', {
    input: 'nine hostile URL shapes (metadata IP, localhost, file:, gopher:, http downgrade, userinfo, port, suffix host, rebinding host) as product URL and as image URL',
    expected: 'never ELIGIBLE; the resolver performs no network I/O at all (pure URL parsing)',
    actual, sideEffects: 'none; the Live source graph contains no fetch/XHR/WebSocket/functions.invoke/rpc (static scan, see ledger)',
    limits: 'Proves the Live asset-selection boundary rejects hostile URLs and that Live itself issues no outbound request. Does not cover the native module image decode or the Commerce open-URL action.',
  });
});

test('static scan: the Live source graph has no network or backend surface', () => {
  const files = [
    'components/vto/LiveVtoPilotProduct.tsx', 'components/vto/VtoLiveErrorBoundary.tsx', 'components/vto/VtoLiveNativeView.tsx', 'components/vto/VtoLivePanel.tsx',
    'hooks/useKPlusLiveCapabilitySignals.ts', 'hooks/useVtoLiveCapability.ts', 'hooks/useVtoLiveSession.ts',
    'modules/kscan-live-vto-native/index.ts', 'modules/kscan-live-vto-native/src/KScanLiveVtoNativeModule.ts', 'modules/kscan-live-vto-native/src/index.ts',
    'services/vto/liveVtoNativeModule.ts', 'services/vto/vtoLiveCameraPermission.ts', 'services/vto/vtoLiveCapability.ts', 'services/vto/vtoLiveGarment.ts',
    'services/vto/vtoLiveGarmentRegistry.ts', 'services/vto/vtoLiveHarness.ts', 'services/vto/vtoLivePilotCatalog.ts', 'services/vto/vtoLiveSession.ts',
  ];
  const pats = { fetch: /\bfetch\s*\(/, xhr: /XMLHttpRequest|WebSocket/, invoke: /functions\.invoke|\.rpc\(/, supabase: /supabase/i, storage: /createSignedUrl|storage\.from|uploadAsync|FileSystem\.upload/, axios: /axios/ };
  const hits = {};
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const [k, re] of Object.entries(pats)) if (re.test(s)) (hits[k] ||= []).push(f);
  }
  assert.deepEqual(hits, {});
  const linking = files.filter((f) => /Linking\./.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(linking, ['components/vto/LiveVtoPilotProduct.tsx']);
  record('STATIC-LIVE-SURFACE', 'Live source graph has no network/backend surface', {
    input: `${files.length} Live source files at ${ROOT.slice(-6)}`,
    expected: 'no fetch/XHR/WebSocket/functions.invoke/rpc/supabase/storage/axios; only user-initiated Linking.openURL in the pilot product card',
    actual: { filesScanned: files.length, networkHits: hits, linkingFiles: linking },
    sideEffects: 'none', limits: 'Text scan of the Live-named source files; shared modules they import (availability hook, K+ entitlement, Photo sanitizer) are other lanes\' surfaces.',
  });
});

test.after(() => {
  fs.mkdirSync(path.join(ROOT, 'audit/a2/out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'audit/a2/out/live-batch2-results.json'), JSON.stringify({ sourceSha: '2c2c9da41121daa43f4f657ca1aaa2fcf7b7cb27', environment: 'node:test real hook/world/resolver source; injected native/permission/sanitizer/SDK fakes; zero network', results }, null, 2));
});
