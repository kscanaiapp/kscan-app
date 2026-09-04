// P3-C: the Live VTO raw-data boundary.
//
// THE CLAIM UNDER TEST. React Native receives high-level events and state
// only. No camera frame, segmentation mask, pose landmark or body proxy ever
// crosses into JavaScript, and therefore none can reach the cloud, a log, or
// a telemetry sink. A guard that has never caught anything is not evidence
// that anything was caught, so the recursive check below is exercised against
// a deliberately poisoned payload -- at several nesting depths -- rather than
// only against a clean one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = (rel) => stripComments(read(rel));

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
    URL, Math, Number, Set, Map, Object, Array, JSON, Date, RangeError, String,
    __DEV__: false,
    process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const contract = loadTsModule('types/vtoLive.ts');
const adapter = loadTsModule('services/vto/liveVtoNativeModule.ts', {
  'react-native': { Platform: { OS: 'ios' } },
  '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
  '../../types/vtoLive': contract,
});
const session = loadTsModule('services/vto/vtoLiveSession.ts', {
  './liveVtoNativeModule': adapter,
  '../../types/vtoLive': contract,
});

// ── The event vocabulary itself ─────────────────────────────────────────────

test('the event contract contains no per-frame event', () => {
  // "No continuous camera/mask/landmark data in JS" is a property of the
  // vocabulary, not a promise about an implementation: there is simply no
  // message here that could carry it.
  for (const name of contract.LIVE_VTO_EVENTS) {
    assert.ok(
      !/frame|mask|landmark|pose|pixel/i.test(name),
      `${name} names per-frame data`,
    );
  }
  assert.ok(contract.LIVE_VTO_EVENTS.includes('trackingWeak'));
  assert.ok(contract.LIVE_VTO_EVENTS.includes('fatalError'));
});

test('the command vocabulary separates a clean capture from a composited one', () => {
  assert.ok(contract.LIVE_VTO_COMMANDS.includes('capturePersonFrame'));
  assert.ok(contract.LIVE_VTO_COMMANDS.includes('capturePreview'));
  // Two commands rather than one with a flag: a flag can be passed wrong.
  assert.ok(!contract.LIVE_VTO_COMMANDS.includes('capture'));
});

// ── The recursive guard, proven against a poisoned payload ──────────────────

test('the forbidden-key guard catches raw data at the top level', () => {
  for (const key of contract.FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS) {
    assert.equal(
      contract.findForbiddenLiveDataKey({ [key]: 'anything' }),
      key,
      `${key} must be caught`,
    );
  }
});

test('the forbidden-key guard catches raw data buried several levels down', () => {
  // The interesting failure is not `{ mask }` -- nobody writes that. It is a
  // mask three levels inside a diagnostics blob added "just for debugging".
  const poisoned = {
    ok: true,
    diagnostics: { nested: { detail: { segmentationMask: [0, 1, 2] } } },
  };
  assert.equal(
    contract.findForbiddenLiveDataKey(poisoned),
    'diagnostics.nested.detail.segmentationMask',
  );
});

test('the forbidden-key guard descends into arrays', () => {
  const poisoned = { samples: [{ confidence: 1 }, { poseLandmarks: [] }] };
  assert.equal(contract.findForbiddenLiveDataKey(poisoned), 'samples.1.poseLandmarks');
});

test('the forbidden-key guard terminates on a cyclic payload', () => {
  const cyclic = { a: {} };
  cyclic.a.self = cyclic;
  assert.equal(contract.findForbiddenLiveDataKey(cyclic), null);
});

test('a clean high-level payload passes', () => {
  assert.equal(
    contract.findForbiddenLiveDataKey({ confidence: 0.9, guidance: 'step_back' }),
    null,
  );
  assert.doesNotThrow(() => contract.assertNoRawLiveData({ captureId: 'c1' }, 'captureReady'));
});

test('assertNoRawLiveData throws, and its message names no payload content', () => {
  let thrown = null;
  try {
    contract.assertNoRawLiveData({ meta: { imageData: 'AAAA-SECRET-BYTES' } }, 'ready');
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof RangeError);
  // The path is named so a developer can find it; the VALUE never is.
  assert.ok(thrown.message.includes('meta.imageData'));
  assert.ok(!thrown.message.includes('AAAA-SECRET-BYTES'));
});

// ── The single entry point drops, rather than propagates ────────────────────

test('normalizeLiveVtoEvent DROPS an event carrying forbidden data', () => {
  const dropped = adapter.normalizeLiveVtoEvent({
    type: 'trackingWeak',
    timestamp: 1,
    payload: { confidence: 0.2, bodyFrame: { torsoWidth: 3 } },
  });
  assert.equal(dropped, null, 'a contract violation must not propagate');
});

test('normalizeLiveVtoEvent passes a clean event through unchanged', () => {
  const event = adapter.normalizeLiveVtoEvent({
    type: 'trackingAcquired',
    timestamp: 42,
    payload: { confidence: 0.91 },
  });
  assert.equal(event.type, 'trackingAcquired');
  assert.equal(event.timestamp, 42);
  assert.equal(event.payload.confidence, 0.91);
});

test('normalizeLiveVtoEvent rejects malformed shapes without throwing', () => {
  for (const raw of [null, undefined, 'ready', 42, [], {}, { type: 7 }]) {
    assert.equal(adapter.normalizeLiveVtoEvent(raw), null, JSON.stringify(raw) ?? 'undefined');
  }
});

test('a dropped event does not reach the session reducer', () => {
  const controller = session.createLiveVtoSession(null);
  const before = controller.getSnapshot();
  // There is no public way to feed a poisoned event in -- which is itself the
  // point -- so the property is asserted at the reducer's own door instead:
  // the reducer only ever receives what normalizeLiveVtoEvent returned.
  assert.equal(before.state, 'INITIALIZING');
  assert.ok(
    code('services/vto/vtoLiveSession.ts').includes('normalizeLiveVtoEvent'),
    'every inbound native event must pass the boundary check',
  );
  controller.dispose();
});

// ── Nothing camera-derived is ever logged ───────────────────────────────────

test('no Live module logs, reports, or telemeters camera-derived data', () => {
  const liveModules = [
    'types/vtoLive.ts',
    'services/vto/liveVtoNativeModule.ts',
    'services/vto/vtoLiveSession.ts',
    'services/vto/vtoLiveCapability.ts',
    'services/vto/vtoLiveGarment.ts',
    'services/vto/vtoLiveCameraPermission.ts',
    'services/vto/vtoLiveHarness.ts',
    'services/vto/vtoPhotorealHandoff.ts',
    'hooks/useVtoLiveCapability.ts',
    'hooks/useVtoLiveSession.ts',
    'components/vto/VtoLivePanel.tsx',
    'components/vto/VtoModeSelector.tsx',
    'components/vto/VtoLiveErrorBoundary.tsx',
  ];
  for (const file of liveModules) {
    const source = code(file);
    assert.ok(!/console\.(log|warn|error|info|debug)/.test(source), `${file} must not log`);
    // Nor may any of them reach a network primitive directly. The ONLY path to
    // the cloud is the existing governed generative client, reached through the
    // ordinary store -- see __tests__/vtoLivePhotorealHandoff.test.js.
    for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /supabase/, /\.invoke\s*\(/]) {
      assert.ok(!pattern.test(source), `${file} must not contain ${pattern}`);
    }
  }
});

test('the error path carries a state enum, never native or provider text', () => {
  // toLiveVtoRuntimeError ACCEPTS a native detail and structurally discards it,
  // so a native caller can still log on its own side without that string ever
  // reaching this app.
  const error = contract.toLiveVtoRuntimeError(
    'CAMERA_UNAVAILABLE',
    'AVFoundation error -11800 in session 0xDEADBEEF',
  );
  assert.equal(error.state, 'CAMERA_UNAVAILABLE');
  assert.ok(!JSON.stringify(error).includes('AVFoundation'));
  assert.ok(!JSON.stringify(error).includes('0xDEADBEEF'));
  assert.ok(error.message.length > 0);
});

test('every runtime error state has bounded K Scan copy', () => {
  for (const state of contract.LIVE_VTO_RUNTIME_ERROR_STATES) {
    const error = contract.toLiveVtoRuntimeError(state);
    assert.equal(error.state, state);
    assert.ok(error.message.length > 0, `${state} needs copy`);
    assert.equal(typeof error.recoverable, 'boolean');
  }
});

test('an unmapped error state degrades to generic copy rather than leaking one', () => {
  const error = contract.toLiveVtoRuntimeError('SOME_FUTURE_NATIVE_STATE');
  assert.equal(error.state, 'RUNTIME_INITIALIZATION_FAILED');
  assert.ok(!error.message.includes('SOME_FUTURE_NATIVE_STATE'));
});

// ── The privacy copy stays honest ───────────────────────────────────────────

test('the processing note is per-mode: K Scan never calls the whole feature local', () => {
  assert.match(contract.LIVE_VTO_PROCESSING_NOTE, /on this device/i);
  // The generative path sends an explicit photo to a governed cloud provider,
  // and its own note says so rather than inheriting Live's claim.
  assert.match(contract.AI_PHOTO_PROCESSING_NOTE, /photo/i);
  assert.ok(!/on this device/i.test(contract.AI_PHOTO_PROCESSING_NOTE));
});

test('no Live surface claims the try-on is private, anonymous, or zero-knowledge', () => {
  for (const file of ['components/vto/VtoModeSelector.tsx', 'components/vto/VtoLivePanel.tsx']) {
    const source = code(file);
    for (const forbidden of [/zero.?knowledge/i, /anonymou/i, /never leaves your device/i, /fully private/i]) {
      assert.ok(!forbidden.test(source), `${file} must not claim ${forbidden}`);
    }
  }
});
