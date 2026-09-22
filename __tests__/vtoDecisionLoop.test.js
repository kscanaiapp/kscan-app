// Build 35 — VTO result and decision-loop polish. BLOCK-VTO-DL-00..22.
//
// WHAT THIS FILE PINS. The result screen stopped being a picture with a wall
// of equal buttons and became a decision surface: one primary action, then
// secondary, then tertiary; a local compare switch; truthful progress; honest
// Retry-After guidance; and a result that can only ever be acted on for the
// product it was generated for. Most of those failure modes are silent -- a
// Shop button for the wrong product, a "Saved" before the write landed, a
// retry button that buys a second generation -- so each is pinned here.
//
// HOW IT TESTS. Same house pattern as vtoUxPolish / vtoRequestLifecycle: the
// decidable logic (services/vto/vtoDecisionLoop.ts, the failure taxonomy, the
// transport's error read, the real request store) is EXECUTED against fakes;
// the React wiring is guarded at source level, because the repo has no
// react-test-renderer. Nothing here touches the network, the filesystem, a
// provider, or Supabase.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that
// literal suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const code = (rel) => stripComments(read(rel));
const intoThisRealm = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadTs(relativePath, requireMap = {}) {
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
    console, exports: mod.exports, module: mod,
    URL, AbortController, setTimeout, clearTimeout, Set, Math, Date, Number, Object,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

// ── The real modules under test ─────────────────────────────────────────────

const types = loadTs('types/vto.ts');
const loop = loadTs('services/vto/vtoDecisionLoop.ts', { '../../types/vto': types });
const failures = loadTs('services/vto/vtoFailures.ts', { '../../types/vto': types });
const progress = loadTs('services/vto/vtoProgressStages.ts', { '../../types/vto': types });

const SHEET = () => code('components/vto/VirtualTryOnSheet.tsx');
const ENTRY = () => code('components/vto/TryItOnEntry.tsx');
const SAVE = () => code('components/vto/VtoSaveToDressingRoom.tsx');
const MODAL = () => code('components/AddScanToDressingRoomModal.tsx');

const GARMENT_A = Object.freeze({
  productRef: 'prod_A',
  imageUrl: 'https://cdn.example.com/blazer-a.jpg',
  category: 'blazer',
  brand: 'Example',
  commerceSource: 'example',
});
const GARMENT_B = Object.freeze({ ...GARMENT_A, productRef: 'prod_B', imageUrl: 'https://cdn.example.com/b.jpg' });
const RESULT = Object.freeze({
  requestId: 'vtoreq_1_x',
  provider: 'fake',
  dataUri: 'data:image/png;base64,AAAA',
  mediaType: 'image/png',
  width: 800,
  height: 1000,
  isAiVisualization: true,
  latencyMs: 1,
});
const SUCCESS_SNAPSHOT = Object.freeze({
  status: 'success',
  requestId: RESULT.requestId,
  garment: GARMENT_A,
  result: RESULT,
});

/** The slice of the sheet's action area rendered for a result on screen. */
function resultActionsBranch() {
  const sheet = SHEET();
  const start = sheet.indexOf(') : resultOnScreen ? (');
  const end = sheet.indexOf(") : vto.status === 'success' ? null : vto.person ? (");
  assert.ok(start > 0 && end > start, 'the result action branch exists');
  return sheet.slice(start, end);
}

/** A named `useCallback` body from the sheet. */
function callbackBody(source, name) {
  const match = source.match(new RegExp(`const ${name} = useCallback\\(([\\s\\S]*?)\\n  \\}, \\[[^\\]]*\\]\\);`));
  assert.ok(match, `${name} must exist`);
  return match[1];
}

// ── BLOCK-VTO-DL-00 / JOURNEY 15 — result product == entry product ──────────

test('BLOCK-VTO-DL-00: a result belongs only to the exact product it was made for', () => {
  assert.equal(loop.vtoResultBelongsToProduct(SUCCESS_SNAPSHOT, GARMENT_A), true);
});

test('BLOCK-VTO-DL-00 / JOURNEY 15: every mismatch fails CLOSED', () => {
  const cases = {
    'different productRef on screen': [SUCCESS_SNAPSHOT, GARMENT_B],
    'same ref, different garment image': [
      SUCCESS_SNAPSHOT, { ...GARMENT_A, imageUrl: 'https://cdn.example.com/other.jpg' },
    ],
    'result from a different request': [
      { ...SUCCESS_SNAPSHOT, result: { ...RESULT, requestId: 'vtoreq_0_old' } }, GARMENT_A,
    ],
    'snapshot garment missing': [{ ...SUCCESS_SNAPSHOT, garment: null }, GARMENT_A],
    'on-screen garment missing': [SUCCESS_SNAPSHOT, null],
    'empty productRef on both sides': [
      { ...SUCCESS_SNAPSHOT, garment: { ...GARMENT_A, productRef: '' } },
      { ...GARMENT_A, productRef: '' },
    ],
    'no result': [{ ...SUCCESS_SNAPSHOT, result: null }, GARMENT_A],
    'no request id': [{ ...SUCCESS_SNAPSHOT, requestId: null }, GARMENT_A],
  };
  for (const [label, [snapshot, onScreen]] of Object.entries(cases)) {
    assert.equal(loop.vtoResultBelongsToProduct(snapshot, onScreen), false, label);
  }
  for (const status of ['idle', 'ready', 'preparing', 'generating', 'validating_result', 'failed', 'cancelled']) {
    assert.equal(
      loop.vtoResultBelongsToProduct({ ...SUCCESS_SNAPSHOT, status }, GARMENT_A),
      false,
      `${status} is not a presentable result`,
    );
  }
});

test('BLOCK-VTO-DL-00: the sheet renders the result AND its actions only through the identity gate', () => {
  const sheet = SHEET();
  assert.match(sheet, /const resultOnScreen = vtoResultBelongsToProduct\(vto, garment\);/);
  // The image, compare and identity block.
  assert.match(sheet, /\{resultOnScreen && displayUri \? \(/);
  assert.match(sheet, /const displayUri = !resultOnScreen\s*\? null/);
  // Every action that could reach Commerce or the Dressing Room sits inside
  // the gated branch -- none in a bare `status === 'success'` branch.
  const branch = resultActionsBranch();
  for (const action of ["renderShop(mode, true)", '<VtoSaveToDressingRoom', 'renderWatch(mode', 'testID="vto-retry"', 'testID="vto-try-another"']) {
    assert.ok(branch.includes(action), `${action} must be inside the identity-gated branch`);
  }
  assert.equal((sheet.match(/<VtoSaveToDressingRoom/g) ?? []).length, 1, 'exactly one save bridge');
  // A success that fails the gate renders NO actions at all.
  assert.match(sheet, /\) : vto\.status === 'success' \? null : vto\.person \? \(/);
});

// ── BLOCK-VTO-DL-01 / 02 / 03 — TRY != OWN != WATCH != SAVE ─────────────────

test('BLOCK-VTO-DL-01..03: the decision loop records no ownership, watch or save', () => {
  const plan = intoThisRealm(loop.planVtoResultActions({ canShop: true, canWatch: true, canSave: true }));
  // A plan is a list of OFFERS. Nothing in it is a state.
  assert.deepEqual(Object.keys(plan).sort(), ['primary', 'secondary', 'shopUnavailable', 'tertiary']);
  const src = code('services/vto/vtoDecisionLoop.ts');
  for (const forbidden of [
    'createWatch', 'addScanImageToDressingRoom', 'AsyncStorage', 'supabase', 'fetch(',
    'markOwned', 'setOwned', 'addClosetItem', 'recordPurchase', 'upsertStyleObject',
  ]) {
    assert.ok(!src.includes(forbidden), `the decision module must not reference ${forbidden}`);
  }
  // Its only dependency is the VTO type vocabulary (also pinned by VTO-NC-010).
  assert.deepEqual([...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]), ['../../types/vto']);
});

test('BLOCK-VTO-DL-01..03: a successful generation changes nothing but the VTO snapshot', () => {
  // The success transition in the sheet emits telemetry and a haptic, and
  // announces the result to a screen reader. Nothing else.
  const sheet = SHEET();
  const viewed = sheet.match(/useEffect\(\(\) => \{\s*if \(!resultOnScreen[\s\S]*?\n  \}, \[[^\]]*\]\);/);
  assert.ok(viewed, 'the result-viewed effect exists');
  for (const forbidden of ['onShop', 'onWatch', 'handlePress', 'Save', 'retry', 'generate']) {
    assert.ok(!viewed[0].includes(forbidden), `viewing a result must not ${forbidden}`);
  }
  assert.match(viewed[0], /emitVtoEvent\('vto_result_viewed'/);
});

// ── BLOCK-VTO-DL-04 / JOURNEY 14 — no Shop without commercial truth ─────────

test('BLOCK-VTO-DL-04: the hierarchy has one primary, and it is Shop only when buyable', () => {
  const buyable = intoThisRealm(loop.planVtoResultActions({ canShop: true, canWatch: true, canSave: true }));
  assert.deepEqual(buyable, {
    primary: 'shop',
    secondary: ['save', 'watch'],
    tertiary: ['try_again', 'try_another'],
    shopUnavailable: false,
  });

  const browseOnly = intoThisRealm(loop.planVtoResultActions({ canShop: false, canWatch: true, canSave: true }));
  assert.equal(browseOnly.primary, null, 'no destination, no Shop');
  assert.equal(browseOnly.shopUnavailable, true, 'and the screen says so in words');
  assert.deepEqual(browseOnly.secondary, ['save', 'watch'], 'Save/Watch follow their own truth');

  const unwatchable = intoThisRealm(loop.planVtoResultActions({ canShop: true, canWatch: false, canSave: true }));
  assert.deepEqual(unwatchable.secondary, ['save']);
});

test('BLOCK-VTO-DL-04 / JOURNEY 14: a non-buyable result renders no Shop button, not a disabled one', () => {
  const branch = resultActionsBranch();
  assert.match(branch, /\{resultPlan\.primary === 'shop' \? \(\s*renderShop\(mode, true\)\s*\) : \(\s*<Text style=\{styles\.shopUnavailable\}/);
  assert.match(SHEET(), /canShop: !!onShop/);
  assert.equal(loop.VTO_DECISION_COPY.shopUnavailable, 'This listing has no shop link right now.');
  // The one Shop element still goes through Commerce's own callback only.
  const shop = SHEET().match(/title="Shop this piece"[\s\S]{0,320}/)[0];
  assert.ok(shop.includes('onShop?.()'));
  for (const forbidden of ['vto.result', 'vto.garment', 'productUrl', 'price', 'retailer', 'Linking']) {
    assert.ok(!shop.includes(forbidden), `Shop must not reconstruct a destination (${forbidden})`);
  }
  assert.equal((SHEET().match(/title="Shop this piece"/g) ?? []).length, 1, 'one Shop element, reused');
});

// ── BLOCK-VTO-DL-05 — Watch uses the existing Watchlist authority ───────────

test('BLOCK-VTO-DL-05: Watch hands off to the surface’s own flow, after collapsing the sheet', () => {
  const entry = ENTRY();
  const handler = callbackBody(entry, 'watchFromTryOn');
  assert.match(handler, /setMinimized\(true\);\s*onWatch\(\);/, 'collapse first, then the surface’s own Watch');
  assert.match(entry, /onWatch=\{onWatch \? watchFromTryOn : undefined\}/, 'no callback, no Watch');
  for (const source of [entry, SHEET(), code('services/vto/vtoDecisionLoop.ts')]) {
    for (const forbidden of ['createWatch', 'watchlistClient', 'WatchThisModal', 'useWatchlist']) {
      assert.ok(!source.includes(forbidden), `VTO must not implement Watch (${forbidden})`);
    }
  }
  // Collapsing for Watch keeps the sheet mounted (the result survives) and
  // the pill never claims a render when nothing runs.
  assert.match(entry, /<VirtualTryOnSheet\s+visible=\{!minimized\}/);
  assert.match(entry, /returnOnly=\{!SESSION_BUSY\.has\(session\.status\) && session\.status !== 'success'\}/);
});

test('BLOCK-VTO-DL-05: the pill reports the state that is true', () => {
  const pill = code('components/vto/VtoMinimizedPill.tsx');
  assert.match(pill, /ready \? VTO_PILL_READY_LABEL : idle \? VTO_PILL_RETURN_LABEL : VTO_PILL_RENDERING_LABEL/);
  assert.equal(progress.VTO_PILL_RETURN_LABEL, 'Back to Try-On');
  assert.doesNotMatch(progress.VTO_PILL_RETURN_LABEL, /render|ready/i);
});

// ── BLOCK-VTO-DL-06 / 20 / 21 — Save: existing path, VTO copy, confirmed ────

test('BLOCK-VTO-DL-06: Save reuses the existing Dressing Room modal in its try-on variant', () => {
  const save = SAVE();
  assert.match(save, /<AddScanToDressingRoomModal[\s\S]*?variant="vto_try_on"/);
  assert.match(save, /sourceType: 'upload_inspiration'/, 'the existing source kind, no new backend type');
  assert.ok(!SHEET().includes('AddScanToDressingRoomModal'), 'the sheet itself stays persistence-free');
});

test('BLOCK-VTO-DL-20: no "avoid faces" copy for an image the customer chose to put themselves in', () => {
  const modal = read('components/AddScanToDressingRoomModal.tsx');
  const vtoCopy = modal.slice(modal.indexOf('vto_try_on: {'), modal.indexOf('} as const;'));
  assert.ok(vtoCopy.length > 0, 'the try-on copy variant exists');
  assert.doesNotMatch(vtoCopy, /avoid faces|faces|bystander/i);
  assert.match(vtoCopy, /title: 'Save this try-on'/, 'it says what is being saved: the try-on');
  assert.match(vtoCopy, /contains the photo you chose/);
  assert.doesNotMatch(vtoCopy, /Save product|Continue Scanning|SAVE SCAN/);
  // The scan copy is unchanged for every other caller.
  const scanCopy = modal.slice(modal.indexOf('  scan: {'), modal.indexOf('vto_try_on: {'));
  assert.match(scanCopy, /Add Scan to Dressing Room/);
  assert.match(scanCopy, /Avoid faces, bystanders, or sensitive information\./);
  assert.match(modal, /variant = 'scan'/, 'the default is the original scan copy');
  // The VTO button says what it saves.
  assert.match(SAVE(), /'Save this try-on'/);
});

test('BLOCK-VTO-DL-21: "Saved" appears only after the Dressing Room write resolves', () => {
  const modal = MODAL();
  // In BOTH write paths, onSaved follows the awaited write and precedes catch.
  for (const handler of ['handleSave', 'handleCreateAndSave']) {
    const body = modal.slice(modal.indexOf(`const ${handler} = async`));
    const tryBlock = body.slice(0, body.indexOf('} catch'));
    const awaitIndex = tryBlock.lastIndexOf('await addScanImageToDressingRoom(');
    const savedIndex = tryBlock.indexOf('onSaved?.(');
    assert.ok(awaitIndex > 0, `${handler} awaits the write`);
    assert.ok(savedIndex > awaitIndex, `${handler}: onSaved only after the write resolved`);
  }
  const save = SAVE();
  // The confirmation state is set in exactly one place: the modal's callback.
  assert.equal((save.match(/setSavedTo\(/g) ?? []).length, 2, 'set by onSaved, cleared per result');
  assert.match(save, /const handleSaved = useCallback\(\(roomTitle: string\) => \{\s*setSavedTo\(roomTitle\);/);
  assert.match(save, /setSavedTo\(null\);/);
  assert.ok(!/onPress=\{[^}]*setSavedTo/.test(save), 'a tap never marks anything saved');
  // The confirmed-save event is emitted from the confirmation, never the tap.
  assert.match(callbackBody(save, 'handleSaved'), /emitVtoEvent\('vto_result_saved'/);
  assert.ok(!callbackBody(save, 'handlePress').includes('vto_result_saved'));
});

// ── BLOCK-VTO-DL-07 — Live gains no cloud egress for UI symmetry ────────────

test('BLOCK-VTO-DL-07: the Live decision exit captures nothing and uploads nothing', () => {
  const sheet = SHEET();
  const start = sheet.indexOf('{liveVisible && live.entered ? (');
  assert.ok(start > 0, 'the Live decision exit exists');
  const block = sheet.slice(start, sheet.indexOf('testID="vto-close"'));
  for (const forbidden of [
    'capturePreview', 'requestPhotoreal', 'capturePersonFrame', 'adoptPerson', 'generate',
    '<Image', 'VtoSaveToDressingRoom', 'previewUri',
  ]) {
    assert.ok(!block.includes(forbidden), `the Live exit must not ${forbidden}`);
  }
  const plan = intoThisRealm(loop.planVtoLiveDecision({ canShop: true, canWatch: true }));
  assert.deepEqual(plan.actions, ['shop', 'watch', 'try_another'], 'no save, no compare in Live');
  assert.deepEqual(
    intoThisRealm(loop.planVtoLiveDecision({ canShop: false, canWatch: false })).actions,
    ['try_another'],
  );
});

// ── BLOCK-VTO-DL-08 / 29 / 39 — never an exact-fit or ownership claim ───────

test('BLOCK-VTO-DL-08: no result-surface copy claims fit, size, taste or ownership', () => {
  const strings = [
    ...Object.values(intoThisRealm(loop.VTO_DECISION_COPY)),
    ...Array.from(progress.VTO_PROGRESS_STAGES, (stage) => stage.label),
    progress.VTO_PILL_RETURN_LABEL, progress.VTO_PILL_READY_LABEL, progress.VTO_PILL_RENDERING_LABEL,
    ...types.VTO_FAILURE_CODES.map((c) => failures.toVtoFailure(c).message),
  ];
  const forbidden = [...loop.VTO_FORBIDDEN_RESULT_CLAIMS, 'exact fit', 'measure'];
  for (const text of strings) {
    for (const claim of forbidden) {
      assert.ok(!String(text).toLowerCase().includes(claim), `"${text}" must not claim "${claim}"`);
    }
  }
  // The sheet's own literals too.
  const sheet = SHEET().toLowerCase();
  for (const claim of loop.VTO_FORBIDDEN_RESULT_CLAIMS) {
    assert.ok(!sheet.includes(claim), `the sheet must not say "${claim}"`);
  }
  // And the AI disclosure is still on every Photo result.
  assert.ok(SHEET().includes('AI VISUALIZATION — NOT A PHOTO, AND NOT A FIT PREDICTION'));
});

// ── BLOCK-VTO-DL-09 / 10 — Try again vs Try another ─────────────────────────

test('BLOCK-VTO-DL-09: Try again repeats THIS product; it is labelled as such', () => {
  const branch = resultActionsBranch();
  assert.match(branch, /title=\{VTO_DECISION_COPY\.tryAgain\}\s*onPress=\{vto\.retry\}/);
  assert.equal(loop.VTO_DECISION_COPY.tryAgain, 'Try again');
  assert.match(loop.VTO_DECISION_COPY.tryAgainHint, /same piece/);
  // retry reads the garment this sheet was opened for -- never a result field.
  const hook = code('hooks/useVirtualTryOn.ts');
  assert.match(hook, /retryVtoGeneration\(\{\s*garment: argsRef\.current\.garment,/);
});

test('BLOCK-VTO-DL-10: Try another returns to the options and generates NOTHING', () => {
  const body = callbackBody(SHEET(), 'handleTryAnother');
  for (const forbidden of ['generate', 'retry', 'adoptPerson', 'selectPerson', 'startVto', 'onShop', 'onWatch']) {
    assert.ok(!body.includes(forbidden), `Try another must not ${forbidden}`);
  }
  assert.match(body, /vto\.dismiss\(\);\s*onClose\(\);/, 'a soft close: the session photo is kept');
  assert.ok(!body.includes('clearPerson'), 'the photo stays ready for the next piece');
  assert.notEqual(loop.VTO_DECISION_COPY.tryAnother, loop.VTO_DECISION_COPY.tryAgain);
  assert.match(loop.VTO_DECISION_COPY.tryAnotherHint, /other options/);
});

// ── BLOCK-VTO-DL-11 / 12 / 22 — stale results and the actor boundary ────────

function createStoreHarness() {
  const actorContext = loadTs('services/actorContext.js');
  const eligibility = loadTs('services/vto/vtoEligibility.ts', { '../../types/vto': types });
  const store = loadTs('services/vto/vtoRequestStore.ts', {
    '../actorContext': actorContext,
    '../../types/vto': types,
    './vtoClient': { requestVtoGeneration: () => Promise.resolve({ ok: false, code: 'unknown' }) },
    './vtoEligibility': eligibility,
    './vtoFailures': failures,
    './vtoPersonInput': {
      buildVtoPersonPayload: (person) => Promise.resolve({
        ok: true, dataUri: 'data:image/jpeg;base64,AAAA', transientUri: `${person.sanitizedUri}.c`,
      }),
      releaseVtoPersonInput: () => Promise.resolve(),
    },
    './vtoTelemetry': { dimensionBucket: () => 'le1024', emitVtoEvent: () => {} },
  });
  return { store, actorContext };
}

const PERSON = Object.freeze({
  source: 'photo_library', sanitizedUri: 'file:///cache/p.jpg', width: 800, height: 1000,
  metadataStripped: true, sanitizerVersion: 't',
});
const OK = (provider) => ({
  ok: true, requestId: 'r', provider, dataUri: 'data:image/png;base64,QUFB', mediaType: 'image/png',
  width: 1, height: 1, latencyMs: 1,
});

test('BLOCK-VTO-DL-11: a stale completion can never become the presented result', async () => {
  const { store, actorContext } = createStoreHarness();
  actorContext.advanceActorEpoch('user-a');
  store.setVtoPersonInput(PERSON, GARMENT_A, 'commerce_product');
  const pending = [];
  const generate = () => new Promise((resolve) => pending.push(resolve));
  const first = store.startVtoGeneration({ garment: GARMENT_A, origin: 'commerce_product', generate });
  await flush();
  const second = store.startVtoGeneration({ garment: GARMENT_A, origin: 'commerce_product', generate });
  await flush();
  pending[1](OK('newer'));
  await second;
  pending[0](OK('older'));
  await first;
  const snap = store.getVtoSnapshot();
  assert.equal(snap.result.provider, 'newer');
  assert.equal(loop.vtoResultBelongsToProduct(snap, GARMENT_A), true);
  assert.equal(snap.result.requestId, snap.requestId, 'the presented result is the newest request');
});

test('BLOCK-VTO-DL-12 / 22: an actor reset leaves no result any action could be offered for', async () => {
  const { store, actorContext } = createStoreHarness();
  actorContext.advanceActorEpoch('user-a');
  store.setVtoPersonInput(PERSON, GARMENT_A, 'commerce_product');
  let release;
  const generate = () => new Promise((resolve) => { release = resolve; });
  const run = store.startVtoGeneration({ garment: GARMENT_A, origin: 'commerce_product', generate });
  await flush();
  // The account changes while user A's generation is still out.
  actorContext.advanceActorEpoch('user-b');
  store.resetVtoRequestState();
  release(OK('late-for-a'));
  await run;
  const snap = store.getVtoSnapshot();
  assert.equal(snap.status, 'idle');
  assert.equal(snap.person, null, 'user A’s photo is gone');
  assert.equal(snap.result, null, 'user A’s late result never lands');
  assert.equal(loop.vtoResultBelongsToProduct(snap, GARMENT_A), false, 'so no Shop/Watch/Save renders');
});

test('BLOCK-VTO-DL-22: the save bridge drops its confirmation and cache copy with the result', () => {
  const save = SAVE();
  const effect = save.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[dataUri\]\);/);
  assert.ok(effect, 'the per-result cleanup effect is keyed on the result itself');
  assert.match(effect[1], /setSavedTo\(null\);/);
  assert.match(effect[1], /setModalVisible\(false\);/);
  assert.match(effect[1], /return \(\) => \{[\s\S]*discardVtoResultExport\(uri\)/);
  // A result that changes while the file is being written cannot leak it.
  assert.match(
    callbackBody(save, 'handlePress'),
    /if \(dataUriRef\.current !== dataUri\) \{\s*void discardVtoResultExport\(exported\.localUri\);\s*return;/,
  );
});

// ── BLOCK-VTO-DL-13 / 14 — compare is local; the result adds no network ─────

test('BLOCK-VTO-DL-13: Compare switches between two on-device images and generates nothing', () => {
  const body = callbackBody(SHEET(), 'handleSelectCompare');
  for (const forbidden of ['generate', 'retry', 'fetch', 'Image.prefetch', 'imageUrl', 'onShop', 'onWatch']) {
    assert.ok(!body.includes(forbidden), `Compare must not ${forbidden}`);
  }
  assert.match(body, /setShowOriginal\(original\);/);
  // The two sources: the in-memory result and the cached photo the customer chose.
  assert.match(SHEET(), /showOriginal && vto\.person\s*\? vto\.person\.sanitizedUri\s*: vto\.result\?\.dataUri \?\? null/);
  // Selected state is exposed to assistive tech, not colour alone.
  assert.match(SHEET(), /accessibilityRole="tab"\s*accessibilityState=\{\{ selected \}\}/);
  assert.match(SHEET(), /VTO_DECISION_COPY\.originalBadge : VTO_DECISION_COPY\.tryOnBadge/);
});

test('BLOCK-VTO-DL-14: the result screen adds no background network request', () => {
  const sheet = SHEET();
  for (const forbidden of ['fetch(', 'supabase', 'functions.invoke', 'Image.prefetch', 'useWatchlist', 'refreshWatches']) {
    assert.ok(!sheet.includes(forbidden), `the sheet must not ${forbidden}`);
  }
  // The catalog image is loaded only on the pre-generation review step, as
  // before -- never by the result block or the compare switch.
  const resultBlock = sheet.slice(
    sheet.indexOf('{resultOnScreen && displayUri ? ('),
    sheet.indexOf('{progress.running ? ('),
  );
  assert.ok(!resultBlock.includes('garment.imageUrl'), 'no remote product image on the result');
  assert.equal((sheet.match(/garment\.imageUrl/g) ?? []).length, 2, 'only the review thumbnail (guard + source)');
});

// ── BLOCK-VTO-DL-15 / 16 / 17 — no backend, provider or paid change ─────────

test('BLOCK-VTO-DL-15..17: no client-visible provider identity or paid path was added', () => {
  const src = code('services/vto/vtoDecisionLoop.ts');
  for (const forbidden of ['rapidapi', 'ailabtools', 'vto-generate', 'provider.', 'VTO_EDGE_FUNCTION']) {
    assert.ok(!src.toLowerCase().includes(forbidden.toLowerCase()), `no ${forbidden}`);
  }
  // The transport still invokes exactly one function, once, with the same body keys.
  const client = code('services/vto/vtoClient.ts');
  assert.equal((client.match(/await invoke\(/g) ?? []).length, 1);
  assert.match(client, /export const VTO_EDGE_FUNCTION = 'vto-generate';/);
});

// ── BLOCK-VTO-DL-18 / 19 — one mode authority; no unavailable mode offered ──

test('BLOCK-VTO-DL-18 / 19: the result surface makes no eligibility decision of its own', () => {
  for (const source of [SHEET(), code('services/vto/vtoDecisionLoop.ts')]) {
    for (const forbidden of [
      'resolveVtoMode', 'useVtoMode', 'useVtoAvailability', 'useVtoLiveCapability',
      'evaluateVtoEligibility', 'resolveVtoCapability', 'EXPO_PUBLIC_', 'isKPlus', 'k_plus',
    ]) {
      assert.ok(!source.includes(forbidden), `must not decide eligibility (${forbidden})`);
    }
  }
  // The Live decision exit exists only while Live is actually on screen, and
  // Live is only on screen when the router affirmatively offered it.
  assert.match(SHEET(), /const liveVisible = liveOffered && mode === 'live' && !liveCrashed;/);
  assert.match(SHEET(), /\{liveVisible && live\.entered \? \(/);
});

// ── Retry-After / in-flight / provider busy (JOURNEYS 8, 9) ────────────────

test('RETRY-AFTER: the client window equals the server window', () => {
  const server = read('supabase/functions/vto-generate/vtoContract.ts');
  const min = Number(server.match(/VTO_RETRY_AFTER_MIN_SECONDS = (\d+)/)[1]);
  const max = Number(server.match(/VTO_RETRY_AFTER_MAX_SECONDS = (\d+)/)[1]);
  assert.equal(failures.VTO_CLIENT_RETRY_AFTER_MIN_SECONDS, min);
  assert.equal(failures.VTO_CLIENT_RETRY_AFTER_MAX_SECONDS, max);
});

test('RETRY-AFTER: guidance is kept only when valid and only where a retry is honest', () => {
  assert.equal(failures.toVtoFailure('provider_busy', { retryAfterSeconds: 30 }).retryAfterSeconds, 30);
  for (const bad of [0, -5, 1.5, 3601, Number.NaN, '30', null, undefined, Infinity]) {
    const failure = failures.toVtoFailure('provider_busy', { retryAfterSeconds: bad });
    assert.equal('retryAfterSeconds' in failure, false, `${String(bad)} is not guidance`);
  }
  // A non-retryable failure never carries a wait: it gets no retry at all.
  const inFlight = failures.toVtoFailure('request_in_flight', { retryAfterSeconds: 30 });
  assert.equal(inFlight.retryable, false);
  assert.equal('retryAfterSeconds' in inFlight, false);
  // The pre-existing single-argument call is unchanged.
  assert.deepEqual(
    intoThisRealm(failures.toVtoFailure('provider_busy')),
    { code: 'provider_busy', message: 'Photo try-on is temporarily busy. Try again shortly.', retryable: true },
  );
});

test('RETRY-AFTER: phrasing is approximate and never invents a wait', () => {
  const f = loop.formatVtoRetryGuidance;
  assert.equal(f(undefined), null);
  assert.equal(f(null), null);
  assert.equal(f(0), null);
  assert.equal(f(2.5), null);
  assert.equal(f(3), 'Try again in a few seconds.');
  assert.equal(f(30), 'Try again in about 30 seconds.');
  assert.equal(f(32), 'Try again in about 35 seconds.');
  assert.equal(f(60), 'Try again in about a minute.');
  assert.equal(f(61), 'Try again in about 2 minutes.');
  assert.equal(f(3600), 'Try again in about 60 minutes.');
  for (const seconds of [3, 30, 90, 3600]) {
    assert.doesNotMatch(f(seconds), /\b429\b|http|provider|supabase|edge|reservation/i);
  }
});

test('RETRY-AFTER: the cooldown only re-enables a button -- it never retries', () => {
  const busy = failures.toVtoFailure('provider_busy', { retryAfterSeconds: 30 });
  assert.equal(loop.vtoRetryCooldownMs(busy), 30_000);
  assert.equal(loop.vtoRetryCooldownMs(failures.toVtoFailure('provider_busy')), 0);
  assert.equal(loop.vtoRetryCooldownMs(null), 0);
  const sheet = SHEET();
  const effect = sheet.match(/useEffect\(\(\) => \{\s*const cooldownMs = vtoRetryCooldownMs\(failure\);[\s\S]*?\n  \}, \[failure\]\);/);
  assert.ok(effect, 'the cooldown effect exists');
  assert.match(effect[0], /setTimeout\(\(\) => setRetryCoolingDown\(false\), cooldownMs\)/);
  for (const forbidden of ['retry(', 'generate(', 'vto.retry', 'vto.generate', 'setInterval', 'startVto']) {
    assert.ok(!effect[0].includes(forbidden), `the cooldown must not ${forbidden}`);
  }
  assert.match(sheet, /disabled=\{!vto\.canGenerate \|\| \(vto\.status === 'failed' && retryCoolingDown\)\}/);
  // And the store schedules nothing on guidance either.
  const store = code('services/vto/vtoRequestStore.ts');
  assert.equal(/setTimeout|setInterval/.test(store), false);
});

test('JOURNEY 9: request_in_flight offers no regenerate -- retry would open a second paid intent', () => {
  const inFlight = failures.toVtoFailure('request_in_flight');
  assert.equal(loop.vtoFailureOffersRetry(inFlight), false);
  assert.equal(loop.vtoFailureOffersRetry(failures.toVtoFailure('provider_busy')), true);
  assert.equal(loop.vtoFailureOffersRetry(null), false);
  // The failed-state primary is gated on retryability; before this lane a
  // non-retryable failure still rendered "Try it on" wired to vto.retry.
  assert.match(
    SHEET(),
    /\{vto\.status !== 'failed' \|\| failureOffersRetry \? \(\s*<PrimaryButton\s*title=\{vto\.status === 'failed' \? 'Try again' : 'Try it on'\}\s*onPress=\{vto\.status === 'failed' \? vto\.retry : vto\.generate\}/,
  );
  // The store's own retry is what opens a new intent -- which is why the gate matters.
  assert.match(code('services/vto/vtoRequestStore.ts'), /export async function retryVtoGeneration[\s\S]*?advanceIntent\(\);/);
});

test('JOURNEY 8: the transport carries the server’s Retry-After into the failure', async () => {
  const client = loadTs('services/vto/vtoClient.ts', {
    '../supabaseClient': { supabase: { functions: { invoke: async () => ({}) } } },
    '../authenticatedFunctionSession': { resolveAuthenticatedFunctionSession: async () => ({ ok: true }) },
    './vtoFailures': failures,
    '../../types/vto': types,
  });
  const httpError = (body) => ({ context: { status: 503, json: async () => body } });
  const args = {
    requestId: 'r1', origin: 'commerce_product', garment: GARMENT_A, personDataUri: 'data:image/jpeg;base64,AA',
  };

  const busy = await client.requestVtoGeneration(args, {
    resolveSession: async () => ({ ok: true }),
    invoke: async () => ({ data: null, error: httpError({ error: { code: 'provider_busy', retryable: true, retryAfterSeconds: 30 } }) }),
  });
  assert.deepEqual(intoThisRealm(busy), { ok: false, code: 'provider_busy', retryAfterSeconds: 30 });

  const noGuidance = await client.requestVtoGeneration(args, {
    resolveSession: async () => ({ ok: true }),
    invoke: async () => ({ data: null, error: httpError({ error: { code: 'provider_busy' } }) }),
  });
  assert.deepEqual(intoThisRealm(noGuidance), { ok: false, code: 'provider_busy' });

  // A 200 carrying a failure envelope keeps the guidance too.
  const envelope = await client.requestVtoGeneration(args, {
    resolveSession: async () => ({ ok: true }),
    invoke: async () => ({ data: { error: { code: 'provider_busy', retryAfterSeconds: 12 } }, error: null }),
  });
  assert.deepEqual(intoThisRealm(envelope), { ok: false, code: 'provider_busy', retryAfterSeconds: 12 });

  // Only the code and the number: the message, stage and provider detail stay out.
  const leaky = await client.readVtoContractErrorDetail(httpError({
    error: { code: 'provider_busy', retryAfterSeconds: 5, message: 'submit_http_429 from rapidapi', stage: 'provider_outcome' },
  }));
  assert.deepEqual(Object.keys(intoThisRealm(leaky)).sort(), ['code', 'retryAfterSeconds']);
  // The legacy single-value reader is unchanged.
  assert.equal(await client.readVtoContractError(httpError({ error: { code: 'provider_busy' } })), 'provider_busy');
});

test('JOURNEY 8: the store puts validated guidance on the failure it presents', async () => {
  const { store, actorContext } = createStoreHarness();
  actorContext.advanceActorEpoch('user-a');
  store.setVtoPersonInput(PERSON, GARMENT_A, 'commerce_product');
  await store.startVtoGeneration({
    garment: GARMENT_A, origin: 'commerce_product',
    generate: async () => ({ ok: false, code: 'provider_busy', retryAfterSeconds: 45 }),
  });
  assert.equal(store.getVtoSnapshot().failure.retryAfterSeconds, 45);

  store.setVtoPersonInput(PERSON, GARMENT_A, 'commerce_product');
  await store.startVtoGeneration({
    garment: GARMENT_A, origin: 'commerce_product',
    generate: async () => ({ ok: false, code: 'provider_busy', retryAfterSeconds: 99_999 }),
  });
  assert.equal('retryAfterSeconds' in store.getVtoSnapshot().failure, false, 'out of window: discarded');
});

// ── Telemetry (brief §40) ───────────────────────────────────────────────────

test('TELEMETRY: the four decision-loop events are allowlisted and content-free', () => {
  const telemetry = loadTs('services/vto/vtoTelemetry.ts');
  const seen = [];
  telemetry.setVtoAnalyticsSink((event, payload) => seen.push([event, intoThisRealm(payload)]));
  for (const event of ['vto_result_viewed', 'vto_result_try_another', 'vto_result_saved', 'vto_exited']) {
    assert.ok(telemetry.VTO_EVENTS.includes(event), `${event} is allowlisted`);
    telemetry.emitVtoEvent(event, {
      origin: 'commerce_product', mode: 'ai_photo',
      productRef: 'prod_A', title: 'Black blazer', uri: 'file:///x.jpg', url: 'https://shop.example/x',
    });
  }
  telemetry.resetVtoAnalyticsSink();
  assert.equal(seen.length, 4);
  for (const [, payload] of seen) {
    assert.deepEqual(payload, { origin: 'commerce_product', mode: 'ai_photo' }, 'nothing but bounded enums');
  }
  // No duplicate of an existing event was added.
  assert.equal(new Set(telemetry.VTO_EVENTS).size, telemetry.VTO_EVENTS.length);
});

// ── Accessibility (brief §36) ───────────────────────────────────────────────

test('ACCESSIBILITY: result, compare, actions and state are all announced in words', () => {
  const sheet = SHEET();
  assert.match(sheet, /AccessibilityInfo\.announceForAccessibility\?\.\('Your try-on is ready\.'\)/);
  assert.match(sheet, /accessibilityLabel="Compare the try-on with your original photo"/);
  assert.match(sheet, /accessibilityHint=\{VTO_DECISION_COPY\.tryAgainHint\}/);
  assert.match(sheet, /accessibilityHint=\{VTO_DECISION_COPY\.tryAnotherHint\}/);
  assert.match(sheet, /accessibilityRole="progressbar"/);
  assert.match(sheet, /accessibilityRole="alert"/);
  // The disabled retry still exposes its state through LuxuryButton's
  // accessibilityState -- pinned there rather than re-implemented here.
  assert.match(code('components/luxury/LuxuryButton.tsx'), /accessibilityState=\{\{ disabled: disabled \|\| loading, busy: loading \}\}/);
});
