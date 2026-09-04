// VTO HOSTILE AUDIT -- Section 29: research contract drift.
//
// WHY THIS FILE EXISTS, AND WHY IT DID NOT.
//
// types/vtoLive.ts and services/vto/liveVtoNativeModule.ts both cite this file
// by name as the mechanical pin on the #291/#295 -> #296 promotion. It did not
// exist. The promoted contract was therefore transcribed by hand and checked by
// nobody, and VTO-HA-001 is what that produced: FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS
// described itself as "the union of both lists" and was one key short of it --
// 'lightingAnalysis', a LOCAL_ONLY_DURING_LIVE class in #291's privacy.ts. A
// payload carrying camera-derived scene analysis passed the guard, survived
// normalizeLiveVtoEvent, and reached the session reducer.
//
// A hand-copied security list is not a contract. This is the contract.
//
// HOW THE AUTHORITY IS READ. #291's source lives in `kscan-live-vto/`, which is
// deliberately NOT part of this app's tree. So the authority is carried two
// ways, and neither of them is a skip:
//
//   1. RECORDED. The exact lists at #291 head 769db50 are transcribed below
//      with their provenance. Every promotion assertion runs against these,
//      unconditionally, in every environment including a shallow CI checkout.
//   2. VERIFIED AGAINST SOURCE. When the #291 ref is reachable from this
//      checkout, the recorded lists are re-read from git and asserted
//      identical. That is what stops the fixture itself from rotting into a
//      second hand-copy of the thing it is meant to police.
//
// Evidence class: CONTRACT TEST (source-derived). Not native, not device.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Authority ───────────────────────────────────────────────────────────────

/** PR #291 head. The research authority for the Live contract. */
const PR291_SHA = '769db5002dff9dbc58eade514bd613488efb1a71';
const PR291_NATIVE_VIEW = 'kscan-live-vto/packages/live-vto-contract/src/nativeView.ts';
const PR291_PRIVACY = 'kscan-live-vto/packages/live-vto-contract/src/privacy.ts';

/** nativeView.ts#FORBIDDEN_EVENT_PAYLOAD_KEYS at PR291_SHA. */
const PR291_FORBIDDEN_EVENT_PAYLOAD_KEYS = [
  'frame', 'pixels', 'imageData', 'mask', 'segmentationMask', 'landmarks',
  'bodyFrame', 'pose',
];

/** privacy.ts#LOCAL_ONLY_DURING_LIVE at PR291_SHA. Data classes that must not
 *  leave the device during a live session. */
const PR291_LOCAL_ONLY_DURING_LIVE = [
  'cameraFrame', 'faceImagery', 'bodyImagery', 'poseLandmarks',
  'segmentationMask', 'bodyProxy', 'cameraDerivedGeometry', 'lightingAnalysis',
  'captureReplayBuffer',
];

/** Reads a `const NAME = [ '...' ]` string array out of TypeScript source. */
function readStringArray(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `could not locate ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** #291's source at its own SHA, or null when the ref is not in this checkout. */
function readPr291(relPath) {
  try {
    return execFileSync('git', ['show', `${PR291_SHA}:${relPath}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const liveContract = read('types/vtoLive.ts');
const promotedForbidden = readStringArray(liveContract, 'FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS');
const promotedEvents = readStringArray(liveContract, 'LIVE_VTO_EVENTS');
const promotedCommands = readStringArray(liveContract, 'LIVE_VTO_COMMANDS');

// ── The recorded authority must still BE the authority ──────────────────────

test('CONTRACT AUTHORITY: the recorded #291 lists match #291 source when reachable', (t) => {
  const nativeView = readPr291(PR291_NATIVE_VIEW);
  const privacy = readPr291(PR291_PRIVACY);
  if (!nativeView || !privacy) {
    // Not a skipped assertion: every promotion test below still runs against
    // the recorded lists. This one check simply cannot be performed without
    // the research ref, and says so rather than passing silently.
    t.diagnostic(`#291 ${PR291_SHA} not present in this checkout; recorded lists used as authority.`);
    return;
  }
  assert.deepEqual(
    readStringArray(nativeView, 'FORBIDDEN_EVENT_PAYLOAD_KEYS'),
    PR291_FORBIDDEN_EVENT_PAYLOAD_KEYS,
    'The recorded copy of #291 FORBIDDEN_EVENT_PAYLOAD_KEYS has drifted from source.',
  );
  assert.deepEqual(
    readStringArray(privacy, 'LOCAL_ONLY_DURING_LIVE'),
    PR291_LOCAL_ONLY_DURING_LIVE,
    'The recorded copy of #291 LOCAL_ONLY_DURING_LIVE has drifted from source.',
  );
});

// ── VTO-HA-001: the promoted guard must cover the whole union ───────────────

test('VTO-HA-001: every #291 forbidden key is guarded by the promoted list', () => {
  const missing = PR291_FORBIDDEN_EVENT_PAYLOAD_KEYS.filter((k) => !promotedForbidden.includes(k));
  assert.deepEqual(missing, [], `#291 FORBIDDEN_EVENT_PAYLOAD_KEYS not promoted: ${missing.join(', ')}`);
});

test('VTO-HA-001: every #291 LOCAL_ONLY_DURING_LIVE data class is guarded', () => {
  const missing = PR291_LOCAL_ONLY_DURING_LIVE.filter((k) => !promotedForbidden.includes(k));
  assert.deepEqual(
    missing,
    [],
    'A data class #291 requires stay local during a live session is not in '
      + `FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS: ${missing.join(', ')}. This is the exact `
      + 'defect VTO-HA-001 recorded -- a camera-derived class reaching JS.',
  );
});

test('VTO-HA-001: lightingAnalysis specifically is guarded', () => {
  // Named on its own so the regression cannot be lost in a set difference.
  assert.ok(
    promotedForbidden.includes('lightingAnalysis'),
    'lightingAnalysis was the key VTO-HA-001 found missing.',
  );
});

test('VTO-HA-001: the guard actually rejects a lightingAnalysis payload at depth', () => {
  const live = loadVtoLive();
  assert.equal(live.findForbiddenLiveDataKey({ lightingAnalysis: { lux: 800 } }), 'lightingAnalysis');
  assert.equal(
    live.findForbiddenLiveDataKey({ perf: { diag: { lightingAnalysis: { lux: 800 } } } }),
    'perf.diag.lightingAnalysis',
  );
  assert.throws(
    () => live.assertNoRawLiveData({ lightingAnalysis: {} }, 'performanceChanged'),
    /forbidden raw live data/,
  );
});

test('the promoted hardening beyond the union is exactly the declared plural/byte spellings', () => {
  const union = new Set([...PR291_FORBIDDEN_EVENT_PAYLOAD_KEYS, ...PR291_LOCAL_ONLY_DURING_LIVE]);
  const additions = promotedForbidden.filter((k) => !union.has(k)).sort();
  // A superset is allowed; an UNDECLARED superset is how a list stops being
  // reviewable. Anything new has to be named here on purpose.
  assert.deepEqual(
    additions,
    ['frames', 'imageBytes', 'masks'],
    'FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS gained a key that is neither in the #291 '
      + 'union nor a declared hardening spelling. Add it here and say why.',
  );
});

// ── Name reconciliation (#291 nativeView vs #295 capture split) ─────────────

test('promoted commands are #291 commands plus the #295 capture split, and nothing else', () => {
  // #291: start/stop/pause/resume/loadGarment/switchGarment/capture/dispose.
  // #295 split capture() into capturePersonFrame/capturePreview and added the
  // explicit requestPhotorealCapture intent. The app adopts the LATER set.
  assert.deepEqual(
    [...promotedCommands].sort(),
    [
      'capturePersonFrame', 'capturePreview', 'dispose', 'loadGarment', 'pause',
      'requestPhotorealCapture', 'resume', 'start', 'stop', 'switchGarment',
    ],
    'The promoted command vocabulary drifted from the #291/#295 reconciliation.',
  );
  assert.ok(!promotedCommands.includes('capture'), "#291's ambiguous capture() must not be promoted.");
});

test('promoted events reconcile with #291, with every divergence declared', () => {
  const pr291Events = [
    'ready', 'trackingAcquired', 'trackingWeak', 'trackingLost', 'trackingRecovered',
    'garmentLoaded', 'captureReady', 'qualityChanged', 'thermalChanged',
    'privacyState', 'fatalError',
  ];
  // Intentional, reviewed divergences. Anything NOT listed here failing below
  // is a silent drift, which is what Section 29 forbids.
  const DROPPED = ['qualityChanged', 'thermalChanged']; // folded into performanceChanged
  const RENAMED = { privacyState: 'privacyStateChanged' };
  const ADDED = ['performanceChanged'];

  const expected = pr291Events
    .filter((e) => !DROPPED.includes(e))
    .map((e) => RENAMED[e] ?? e)
    .concat(ADDED);
  assert.deepEqual([...promotedEvents].sort(), [...expected].sort(),
    'The promoted event vocabulary diverged from #291 in a way nobody declared.');
});

test('no promoted event name is per-frame -- the no-continuous-data rule is structural', () => {
  for (const name of promotedEvents) {
    assert.ok(
      !/frame|mask|landmark|pose|pixel/i.test(name),
      `${name} names per-frame data. The event vocabulary is what makes "no continuous `
        + 'camera data in JS" a property of the contract rather than a promise.',
    );
  }
});

test('fatalError drops #291\'s free-text native message', () => {
  // #291: fatalError { code: string; message: string; recoverable: boolean }.
  // Promoting `message` would carry provider/ML strings to a customer screen.
  const payloads = liveContract.slice(liveContract.indexOf('interface LiveVtoEventPayloads'));
  const fatal = payloads.slice(payloads.indexOf('fatalError:'), payloads.indexOf('fatalError:') + 200);
  assert.ok(/state:\s*LiveVtoRuntimeErrorState/.test(fatal), 'fatalError must carry a bounded state enum.');
  assert.ok(!/\bmessage\b/.test(fatal.split('\n')[0] + fatal.split('\n')[1]),
    'fatalError must not carry a free-text native message.');
});

// ── Capture kinds and the clean-frame rule (#295 capturePipeline) ───────────

test('capture kinds match #295 and only PERSON_FRAME may feed generation', () => {
  const kinds = readStringArray(liveContract, 'LIVE_VTO_CAPTURED_FRAME_KINDS');
  assert.deepEqual(kinds, ['PERSON_FRAME', 'PREVIEW'], 'Capture kinds drifted from #295 capturePipeline.ts.');
  const live = loadVtoLive();
  assert.throws(() => live.assertCleanPersonFrame({ captureId: 'a', kind: 'PREVIEW', localUri: 'x' }), /PERSON_FRAME/);
  live.assertCleanPersonFrame({ captureId: 'a', kind: 'PERSON_FRAME', localUri: 'x', width: null, height: null });
});

test('photoreal intent states and privacy phases match #295 exactly', () => {
  assert.deepEqual(
    readStringArray(liveContract, 'PHOTOREAL_INTENT_STATES'),
    ['LIVE_LOCAL', 'CAPTURE_CONSENT', 'STILL_CAPTURED', 'GENERATIVE_HANDOFF_READY'],
  );
  const live = loadVtoLive();
  assert.deepEqual(Object.keys(live.PHOTOREAL_STATE_TO_PRIVACY_PHASE).sort(), [
    'CAPTURE_CONSENT', 'GENERATIVE_HANDOFF_READY', 'LIVE_LOCAL', 'STILL_CAPTURED',
  ]);
  assert.equal(live.PHOTOREAL_STATE_TO_PRIVACY_PHASE.LIVE_LOCAL, 'live');
  // Every transition out of LIVE_LOCAL requires an explicit user action.
  for (const transition of live.PHOTOREAL_INTENT_TRANSITIONS) {
    assert.equal(transition.requiresExplicitUserAction, true);
  }
});

test('photoreal failure codes: #295 codes preserved, divergences declared', () => {
  const codes = readStringArray(liveContract, 'PHOTOREAL_FAILURE_CODES');
  const pr295 = [
    'capture_cancelled', 'no_usable_still', 'garment_not_eligible',
    'bridge_contract_mismatch', 'feature_disabled', 'entitlement_missing',
    'provider_unavailable', 'generation_failed',
  ];
  // bridge_contract_mismatch is a research-bridge-adapter condition; this app
  // has no bridge adapter, so it has no producer here. harness_active is the
  // app-side addition that keeps a simulated session provider-inert.
  const DROPPED = ['bridge_contract_mismatch'];
  const ADDED = ['harness_active'];
  assert.deepEqual(
    [...codes].sort(),
    [...pr295.filter((c) => !DROPPED.includes(c)), ...ADDED].sort(),
    'Photoreal failure codes drifted from #295 failureModes.ts undeclared.',
  );
  const live = loadVtoLive();
  for (const code of codes) {
    // One handler, no per-code branch: a cloud failure never ends a local session.
    assert.equal(live.handlePhotorealFailure(code).liveSessionRemainsUsable, true);
    assert.equal(live.handlePhotorealFailure(code).resultingState, 'LIVE_LOCAL');
  }
});

// ── Loader ──────────────────────────────────────────────────────────────────

function loadVtoLive() {
  const vm = require('node:vm');
  const ts = require('typescript');
  const output = ts.transpileModule(read('types/vtoLive.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    exports: mod.exports, module: mod, console, Object, Array, Set, Map, JSON,
    Math, Number, String, Boolean, Date, RangeError, Error,
    require: (s) => { throw new Error(`unexpected import ${s}`); },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: 'types/vtoLive.ts' }).runInContext(sandbox);
  return mod.exports;
}
