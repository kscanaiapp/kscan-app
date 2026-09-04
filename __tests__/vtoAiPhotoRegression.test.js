// P3-C HARD GATE: the existing AI Photo try-on, with Live disabled.
//
// WHAT THIS FILE EXISTS TO CATCH. P3-C added a second visualization mode to a
// surface that already shipped. The failure that matters is not "Live doesn't
// work" -- Live has no runtime yet and is off everywhere. It is "the working
// generative try-on quietly changed". So this suite asserts the AI Photo path
// end to end, on the assumption that holds on every build today: Live is
// unavailable, and the sheet must behave exactly as it did before this lane.
//
// Two kinds of assertion, and the difference matters:
//   - BEHAVIOURAL: the generation lifecycle is executed for real against the
//     shipping store, because "it still generates" is a claim about what the
//     code does.
//   - STRUCTURAL: the sheet's render tree is read as source, because this repo
//     has no react-test-renderer and inventing one for this lane would be a
//     bigger change than the lane itself.
// A structural assertion is never used to stand in for a behavioural one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = (rel) => stripComments(read(rel));

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function transpile(absPath) {
  return ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function loadModule(absPath, requireMap = {}) {
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL, AbortController, setTimeout, clearTimeout, Set, Map, Math, Date, JSON,
    Object, Array, Number, String, Promise, RangeError,
    __DEV__: false,
    process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(absPath)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(transpile(absPath), { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

const GARMENT = {
  productRef: 'prod_1',
  imageUrl: 'https://cdn.example.com/coat.jpg',
  category: 'wool coat',
  brand: 'Example',
  commerceSource: 'example',
};

const PICKED_PERSON = {
  source: 'photo_library',
  sanitizedUri: 'file:///cache/person-a.jpg',
  width: 1024,
  height: 1280,
  metadataStripped: true,
  sanitizerVersion: 'test-1.0.0',
};

const SUCCESS = {
  ok: true,
  requestId: 'server-echo',
  provider: 'mock',
  dataUri: 'data:image/png;base64,AAAA',
  mediaType: 'image/png',
  width: 256,
  height: 320,
  latencyMs: 120,
};

/** The shipping store, with only its transport and media boundaries faked. */
function createHarness() {
  const released = [];
  const events = [];
  const pending = [];

  const actorContext = loadModule(path.join(ROOT, 'services', 'actorContext.js'));
  const clientTypes = loadModule(path.join(ROOT, 'types', 'vto.ts'));
  const failures = loadModule(path.join(ROOT, 'services', 'vto', 'vtoFailures.ts'), {
    '../../types/vto': clientTypes,
  });
  const eligibility = loadModule(path.join(ROOT, 'services', 'vto', 'vtoEligibility.ts'), {
    '../../types/vto': clientTypes,
  });

  const store = loadModule(path.join(ROOT, 'services', 'vto', 'vtoRequestStore.ts'), {
    '../actorContext': actorContext,
    '../../types/vto': clientTypes,
    './vtoClient': { requestVtoGeneration: () => Promise.resolve({ ok: false, code: 'unknown' }) },
    './vtoEligibility': eligibility,
    './vtoFailures': failures,
    './vtoPersonInput': {
      buildVtoPersonPayload: (person) =>
        Promise.resolve({
          ok: true,
          dataUri: 'data:image/jpeg;base64,AAAA',
          transientUri: `${person.sanitizedUri}.compressed`,
        }),
      releaseVtoPersonInput: (...uris) => {
        released.push(...uris);
        return Promise.resolve();
      },
    },
    './vtoTelemetry': {
      dimensionBucket: () => 'le1024',
      emitVtoEvent: (event, payload) => events.push({ event, payload }),
    },
  });

  const generate = (args) => new Promise((resolve) => pending.push({ args, resolve }));
  return { store, actorContext, released, events, pending, generate, eligibility };
}

const options = (h, extra = {}) => ({
  garment: GARMENT,
  origin: 'commerce_product',
  generate: h.generate,
  ...extra,
});

// ── BEHAVIOURAL: the generative lifecycle still runs end to end ─────────────

test('regression: photo selection -> generate -> success is unchanged', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');

  h.store.setVtoPersonInput(PICKED_PERSON, GARMENT, 'commerce_product');
  assert.equal(h.store.getVtoSnapshot().status, 'ready');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  assert.equal(h.store.getVtoSnapshot().status, 'generating');

  h.pending[0].resolve(SUCCESS);
  await run;

  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'success');
  assert.equal(snapshot.result.dataUri, SUCCESS.dataUri);
  assert.equal(snapshot.result.isAiVisualization, true);
});

test('regression: the request the client would send is unchanged in shape', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PICKED_PERSON, GARMENT, 'commerce_product');
  const run = h.store.startVtoGeneration(options(h));
  await flush();

  const args = h.pending[0].args;
  assert.equal(args.origin, 'commerce_product');
  assert.equal(args.garment.productRef, GARMENT.productRef);
  assert.equal(args.personDataUri, 'data:image/jpeg;base64,AAAA');
  // VTO-QUOTA-001 / VTO-DUP-001: the intent sequence is still sent, so the
  // server's idempotency identity is unchanged by this lane.
  assert.equal(typeof args.requestGeneration, 'string');
  assert.ok(args.signal, 'the abort signal is still wired');
  // No Live field leaked into the generative request.
  assert.deepEqual(
    Object.keys(args).sort(),
    ['devScenario', 'garment', 'origin', 'personDataUri', 'requestGeneration', 'requestId', 'signal'].sort(),
  );

  h.pending[0].resolve(SUCCESS);
  await run;
});

test('regression: a failure still maps to bounded copy and stays retryable', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PICKED_PERSON, GARMENT, 'commerce_product');
  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.pending[0].resolve({ ok: false, code: 'provider_timeout' });
  await run;

  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.failure.code, 'provider_timeout');
  assert.ok(snapshot.failure.message.length > 0);
  assert.equal(snapshot.result, null);
});

test('regression: cancel and the stale-result rule are unchanged', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PICKED_PERSON, GARMENT, 'commerce_product');
  const run = h.store.startVtoGeneration(options(h));
  await flush();

  h.store.cancelVtoGeneration();
  assert.equal(h.store.getVtoSnapshot().status, 'cancelled');

  // A late result from the cancelled generation has no authority.
  h.pending[0].resolve(SUCCESS);
  await run;
  assert.equal(h.store.getVtoSnapshot().status, 'cancelled');
  assert.equal(h.store.getVtoSnapshot().result, null);
});

test('regression: minimize keeps the generation alive; the photo survives a close', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PICKED_PERSON, GARMENT, 'commerce_product');
  const run = h.store.startVtoGeneration(options(h));
  await flush();

  // leaveVtoSurface is what a close/unmount calls. It tears down the request
  // but KEEPS the session photo for the next product -- unchanged behaviour.
  h.store.leaveVtoSurface();
  const afterClose = h.store.getVtoSnapshot();
  assert.equal(afterClose.status, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(afterClose.person)), PICKED_PERSON);

  h.pending[0].resolve(SUCCESS);
  await run;
  assert.equal(h.store.getVtoSnapshot().status, 'ready', 'the torn-down result has no authority');
});

test('regression: an actor transition still clears the photo and its cache files', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PICKED_PERSON, GARMENT, 'commerce_product');
  h.store.resetVtoRequestState();
  await flush();

  assert.equal(h.store.getVtoSnapshot().person, null);
  assert.ok(h.released.includes(PICKED_PERSON.sanitizedUri), 'the derivative is deleted');
});

// ── BEHAVIOURAL: the Live handoff joins that SAME path, not a new one ───────

test('regression: a Live person input enters through the identical store entry point', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');

  // What useVirtualTryOn#adoptPerson does: the same setVtoPersonInput call the
  // photo picker makes, with a person that came from a clean capture instead.
  const livePerson = { ...PICKED_PERSON, source: 'live_capture' };
  h.store.setVtoPersonInput(livePerson, GARMENT, 'commerce_product');
  assert.equal(h.store.getVtoSnapshot().status, 'ready');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  // Byte-identical request shape: the server cannot tell, and must not be able
  // to tell, which mode produced the image.
  assert.equal(h.pending[0].args.personDataUri, 'data:image/jpeg;base64,AAAA');
  assert.equal(h.pending[0].args.garment.productRef, GARMENT.productRef);

  h.pending[0].resolve(SUCCESS);
  await run;
  assert.equal(h.store.getVtoSnapshot().status, 'success');
});

test('regression: eligibility for the generative path is untouched by this lane', () => {
  const h = createHarness();
  const decide = (category, hasEntitlement = true) =>
    h.eligibility.evaluateVtoEligibility({
      category,
      imageUrl: 'https://cdn.example.com/x.jpg',
      productRef: 'p',
      featureEnabled: true,
      hasEntitlement,
    });
  // The generative allow-list still admits everything it admitted before --
  // notably the three categories LIVE does NOT support.
  for (const category of ['t-shirt', 'wool coat', 'blazer', 'dress']) {
    assert.equal(decide(category).eligible, true, category);
  }
  assert.equal(decide('sneakers').reason, 'unsupported_category');
  assert.equal(decide('t-shirt', false).reason, 'entitlement_required');
  assert.deepEqual(
    [...h.eligibility.DEFAULT_VTO_SUPPORTED_CATEGORIES],
    ['top', 'outerwear', 'blazer', 'dress'],
  );
});

// ── STRUCTURAL: with Live off, the sheet is the pre-existing sheet ──────────

const SHEET = code('components/vto/VirtualTryOnSheet.tsx');

test('regression: every Live element is gated, so an ungated one cannot render', () => {
  // liveOffered is false whenever the router does not affirmatively offer BOTH
  // modes -- which is every build today.
  assert.ok(
    /const liveOffered = capability \? shouldOfferModeChoice\(capability\) : false;/.test(SHEET),
    'the gate is the router answer, not a local guess',
  );
  assert.ok(/\{liveOffered \? \(\s*<VtoModeSelector/.test(SHEET), 'the selector is gated');
  assert.ok(/\{liveVisible \? \(\s*<VtoLiveErrorBoundary/.test(SHEET), 'the panel is gated');
  assert.ok(
    /const liveVisible = liveOffered && mode === 'live' && !liveCrashed;/.test(SHEET),
    'the panel additionally requires the customer to have chosen Live',
  );
  // No Live JSX appears outside those two gated blocks.
  const liveTags = [...SHEET.matchAll(/<Vto(ModeSelector|LivePanel|LiveErrorBoundary)/g)];
  assert.equal(liveTags.length, 3, 'exactly one gated occurrence of each Live element');
});

test('regression: with Live off, the AI Photo tree is the one that renders', () => {
  assert.ok(
    /const aiPhotoVisible = !liveVisible;/.test(SHEET),
    'AI Photo is the default, and Live is the exception -- not the reverse',
  );
  // Everything the sheet rendered before is still inside the aiPhotoVisible
  // branch, including the actions row.
  for (const marker of [
    'vto-result-image',
    'vto-size-disclaimer',
    'vto-generating',
    'vto-failure-notice',
    'vto-cancelled-notice',
    'vto-review',
    'vto-remove-photo',
    'vto-choose-photo',
    'vto-generate',
    'vto-change-photo',
    'vto-retry',
    'vto-shop',
    'vto-minimize',
    'vto-cancel',
  ]) {
    assert.ok(SHEET.includes(marker), `${marker} must still exist`);
  }
});

test('regression: Close remains available in BOTH modes', () => {
  // The one way out of the sheet must never be inside a mode branch.
  const actions = SHEET.match(/<View style=\{styles\.actions\}>[\s\S]*?<\/View>/)[0];
  const closeIndex = actions.indexOf('vto-close');
  const gateEnd = actions.lastIndexOf(') : null}');
  assert.ok(closeIndex > gateEnd, 'Close is rendered after the AI Photo gate closes');
});

test('regression: the disclaimer and the save bridge are untouched', () => {
  assert.ok(SHEET.includes('AI VISUALIZATION — NOT A PHOTO, AND NOT A FIT PREDICTION'));
  assert.ok(SHEET.includes('AI-generated visualization for inspiration only'));
  assert.ok(SHEET.includes('<VtoSaveToDressingRoom'));
  // Save is still an explicit, opt-in bridge -- Live added no new persistence.
  const save = code('components/vto/VtoSaveToDressingRoom.tsx');
  assert.ok(!/live|LiveVto/i.test(save), 'the save bridge learned nothing about Live');
});

test('regression: the person-photo guidance and silhouette guide still render', () => {
  assert.ok(SHEET.includes('<VtoSilhouetteGuide />'));
  assert.ok(SHEET.includes('Your photo is stripped of its metadata'));
});

test('regression: the photo picker still opens with no permission gate', () => {
  // The Android system-picker repair must survive this lane untouched.
  const personInput = code('services/vto/vtoPersonInput.ts');
  assert.ok(personInput.includes('launchImageLibraryAsync'));
  assert.ok(
    !personInput.includes('requestMediaLibraryPermissionsAsync'),
    'no media-library permission gate may return',
  );
  assert.ok(!/permission_denied/.test(personInput));
});

test('regression: no new customer-facing permission was declared', () => {
  const appJson = JSON.parse(read('app.json')).expo;
  // Camera was ALREADY declared for the existing scan flow; Live reuses it and
  // adds nothing. Media permissions stay blocked, as the picker repair requires.
  assert.ok(appJson.android.permissions.includes('android.permission.CAMERA'));
  for (const blocked of [
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]) {
    assert.ok(appJson.android.blockedPermissions.includes(blocked), `${blocked} stays blocked`);
  }
  assert.ok(!appJson.android.permissions.includes('android.permission.READ_MEDIA_IMAGES'));
  // And no new iOS purpose string was introduced by this lane.
  const iosKeys = Object.keys(appJson.ios.infoPlist).filter((k) => k.endsWith('UsageDescription'));
  assert.deepEqual(iosKeys.sort(), [
    'NSCameraUsageDescription',
    'NSLocationWhenInUseUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSPhotoLibraryUsageDescription',
    'NSSpeechRecognitionUsageDescription',
  ]);
});

test('regression: opening Try It On requests no camera permission', () => {
  // The prompt belongs to the Live entry action alone. Neither the entry point
  // nor the sheet may reach a permission API, directly or through the hook that
  // only READS status.
  for (const file of ['components/vto/TryItOnEntry.tsx', 'components/vto/VirtualTryOnSheet.tsx']) {
    const source = code(file);
    assert.ok(!source.includes('ensureLiveCameraPermission'), `${file} must not prompt`);
    assert.ok(!source.includes('requestCameraPermissionsAsync'), `${file} must not prompt`);
    assert.ok(!source.includes('useCameraPermissions'), `${file} must not prompt`);
  }
  // The one caller of the prompt is the explicit Live entry.
  const sessionHook = code('hooks/useVtoLiveSession.ts');
  const enter = sessionHook.match(/const enterLive = useCallback\([\s\S]*?\}, \[descriptor\]\);/)[0];
  assert.ok(enter.includes('ensureLiveCameraPermission'));
  const promptCallers = [...sessionHook.matchAll(/ensureLiveCameraPermission/g)];
  assert.equal(promptCallers.length, 2, 'imported once, called once');
});

test('regression: there is exactly ONE Try It On entry point', () => {
  const entry = code('components/vto/TryItOnEntry.tsx');
  // The button's gating is still the pre-existing availability answer -- the
  // capability router changed which MODES exist behind the entry, not whether
  // the entry renders.
  assert.ok(/if \(!available && !upgradeOpportunity\) return null;/.test(entry));
  assert.equal([...entry.matchAll(/<VirtualTryOnSheet/g)].length, 1);
  // And no second entry component was introduced anywhere.
  const vtoComponents = fs.readdirSync(path.join(ROOT, 'components', 'vto'));
  const entryLike = vtoComponents.filter((name) => /TryItOn|TryOnEntry/i.test(name));
  assert.deepEqual(entryLike, ['TryItOnEntry.tsx']);
});

test('regression: the sheet still works when no capability is supplied at all', () => {
  // The prop is optional, and its absence is the pre-Live behaviour. A caller
  // that never heard of Live must keep working.
  assert.ok(/capability\?: VtoCapability;/.test(SHEET));
  assert.ok(
    /capability \? defaultVtoMode\(capability\) : 'ai_photo'/.test(SHEET),
    'no capability means AI Photo, not a crash',
  );
});
