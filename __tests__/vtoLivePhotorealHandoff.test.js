// P3-C: Live -> Photoreal, the clean-frame rule, and generative governance.
//
// THREE PROPERTIES, ALL EXECUTED RATHER THAN READ:
//
//   1. Only a PERSON_FRAME may feed the generative path. A composited PREVIEW
//      is refused at the one gate every handoff passes through.
//   2. The handoff never becomes automatic. The intent machine takes no timer,
//      no tracking event and no measurement -- only its own current state -- so
//      there is structurally no path from "a session is running" to "a photo
//      was sent".
//   3. A generative failure never ends the Live session. Every failure code
//      resolves through one shared handler that cannot special-case a code
//      into a worse outcome.
//
// Plus the governance claim: Live reaches the cloud through the EXISTING
// store/client/Edge Function, not a second path, so authentication, K+
// entitlement, quota, reservation, idempotency and provider configuration are
// untouched by this lane.

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
    URL, Math, Number, Set, Map, Object, Array, JSON, Date, RangeError, String, Promise,
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

// Modules are evaluated inside a vm context, so values they return belong to
// another realm and deepStrictEqual would compare prototypes rather than
// structure. Rehydrate before comparing -- the same convention
// vtoUxPolish.test.js uses.
const intoThisRealm = (value) => JSON.parse(JSON.stringify(value));

const cleanupCalls = [];
function loadHandoff(overrides = {}) {
  return loadTsModule('services/vto/vtoPhotorealHandoff.ts', {
    '../privacyImageUpload': {
      cleanupSanitizedImage: async (uri) => {
        cleanupCalls.push(uri);
      },
      prepareImageForPrivacyUpload: overrides.prepare
        ?? (async () => ({
          sanitizedUri: 'file:///cache/clean.jpg',
          width: 800,
          height: 1200,
          policy: { metadataStripped: true, sanitizerVersion: 'test-1' },
        })),
    },
    './vtoLiveHarness': { isLiveVtoHarnessActive: overrides.harnessActive ?? (() => false) },
    './vtoPersonInput': { VTO_PERSON_MAX_DIMENSION: 1024, VTO_PERSON_JPEG_QUALITY: 0.8 },
    '../../types/vto': {},
    '../../types/vtoLive': contract,
  });
}

const personFrame = {
  captureId: 'cap-1',
  kind: 'PERSON_FRAME',
  localUri: 'file:///cache/person.jpg',
  width: 1080,
  height: 1920,
};
const previewFrame = { ...personFrame, captureId: 'cap-2', kind: 'PREVIEW' };

// ── 1. The clean-frame rule ─────────────────────────────────────────────────

test('clean frame: a PERSON_FRAME is accepted', () => {
  assert.doesNotThrow(() => contract.assertCleanPersonFrame(personFrame));
});

test('clean frame: a composited PREVIEW is refused at the gate', () => {
  assert.throws(() => contract.assertCleanPersonFrame(previewFrame), RangeError);
});

test('clean frame: a missing or malformed handle is refused, not assumed clean', () => {
  for (const handle of [null, undefined, {}, { kind: 'person_frame' }, { kind: '' }]) {
    assert.throws(() => contract.assertCleanPersonFrame(handle), RangeError);
  }
});

test('clean frame: the guarantee is the declared kind, never a pixel heuristic', () => {
  // A dimension comparison or "does this look composited" check would be both
  // defeatable and wrong. None exists anywhere in this integration.
  for (const file of [
    'types/vtoLive.ts',
    'services/vto/vtoPhotorealHandoff.ts',
    'services/vto/vtoLiveSession.ts',
    'hooks/useVtoLiveSession.ts',
  ]) {
    const source = code(file);
    for (const pattern of [/width\s*===\s*.*height/, /aspectRatio/i, /looksComposited/i, /pixelDiff/i]) {
      assert.ok(!pattern.test(source), `${file} must not infer cleanliness from ${pattern}`);
    }
  }
});

test('handoff: a PREVIEW never becomes a generative input', async () => {
  const handoff = loadHandoff();
  const outcome = await handoff.buildPhotorealPersonInput(previewFrame);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'no_usable_still');
  assert.equal(outcome.failure.liveSessionRemainsUsable, true);
});

test('handoff: a PERSON_FRAME yields the ordinary sanitized person input', async () => {
  const handoff = loadHandoff();
  const outcome = await handoff.buildPhotorealPersonInput(personFrame);
  assert.equal(outcome.ok, true);
  // The SAME shape the photo picker produces, so the generation runs down the
  // ordinary governed path rather than a Live-specific one.
  assert.equal(outcome.person.source, 'live_capture');
  assert.equal(outcome.person.sanitizedUri, 'file:///cache/clean.jpg');
  assert.equal(outcome.person.metadataStripped, true);
  assert.equal(typeof outcome.person.sanitizerVersion, 'string');
});

test('handoff: a sanitizer that did not strip metadata stops the image leaving', async () => {
  cleanupCalls.length = 0;
  const handoff = loadHandoff({
    prepare: async () => ({
      sanitizedUri: 'file:///cache/dirty.jpg',
      width: 10,
      height: 10,
      policy: { metadataStripped: false, sanitizerVersion: 'test-1' },
    }),
  });
  const outcome = await handoff.buildPhotorealPersonInput(personFrame);
  assert.equal(outcome.ok, false);
  // And the derivative is deleted rather than left in the cache.
  assert.deepEqual(cleanupCalls, ['file:///cache/dirty.jpg']);
});

test('handoff: a sanitizer that throws fails closed, not open', async () => {
  const handoff = loadHandoff({
    prepare: async () => {
      throw new Error('boom');
    },
  });
  const outcome = await handoff.buildPhotorealPersonInput(personFrame);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.liveSessionRemainsUsable, true);
});

// ── 2. The handoff is explicit, always ──────────────────────────────────────

test('intent: every transition requires an explicit user action', () => {
  for (const transition of contract.PHOTOREAL_INTENT_TRANSITIONS) {
    assert.equal(transition.requiresExplicitUserAction, true, `${transition.from}->${transition.to}`);
  }
});

test('intent: the advance function takes ONLY the current state', () => {
  // No timer, no elapsed time, no tracking event, no measurement -- so there is
  // structurally no automatic path from a live session into a cloud request.
  assert.equal(contract.advancePhotorealIntent.length, 1);
  const step = contract.advancePhotorealIntent('LIVE_LOCAL');
  assert.deepEqual(intoThisRealm(step), { ok: true, from: 'LIVE_LOCAL', to: 'CAPTURE_CONSENT' });
});

test('intent: the machine walks exactly one path and then stops', () => {
  let state = 'LIVE_LOCAL';
  const visited = [state];
  for (let i = 0; i < 10; i += 1) {
    const step = contract.advancePhotorealIntent(state);
    if (!step.ok) break;
    state = step.to;
    visited.push(state);
  }
  assert.deepEqual(visited, [
    'LIVE_LOCAL',
    'CAPTURE_CONSENT',
    'STILL_CAPTURED',
    'GENERATIVE_HANDOFF_READY',
  ]);
  assert.deepEqual(intoThisRealm(contract.advancePhotorealIntent('GENERATIVE_HANDOFF_READY')), {
    ok: false,
    reason: 'terminal_state',
  });
  assert.deepEqual(intoThisRealm(contract.advancePhotorealIntent('NOT_A_STATE')), {
    ok: false,
    reason: 'unknown_state',
  });
});

test('intent: only LIVE_LOCAL maps to the local privacy phase', () => {
  assert.equal(contract.PHOTOREAL_STATE_TO_PRIVACY_PHASE.LIVE_LOCAL, 'live');
  for (const state of contract.PHOTOREAL_INTENT_STATES.filter((s) => s !== 'LIVE_LOCAL')) {
    assert.notEqual(contract.PHOTOREAL_STATE_TO_PRIVACY_PHASE[state], 'live', state);
  }
});

// ── 3. Matrix G: a Photoreal failure never ends the Live session ────────────

test('matrix G: EVERY photoreal failure code returns to a usable Live session', () => {
  for (const codeName of contract.PHOTOREAL_FAILURE_CODES) {
    const outcome = contract.handlePhotorealFailure(codeName);
    assert.equal(outcome.code, codeName);
    assert.equal(outcome.resultingState, 'LIVE_LOCAL', codeName);
    assert.equal(outcome.liveSessionRemainsUsable, true, codeName);
  }
});

test('matrix G: a backend failure maps into that same single handler', () => {
  const handoff = loadHandoff();
  const backendCodes = [
    'feature_disabled',
    'entitlement_required',
    'unsupported_category',
    'provider_unavailable',
    'provider_timeout',
    'rate_limited',
    'cancelled',
    'generation_failed',
    'something_new',
    null,
  ];
  for (const backendCode of backendCodes) {
    const outcome = handoff.photorealOutcomeForGenerativeFailure(backendCode);
    assert.equal(outcome.liveSessionRemainsUsable, true, String(backendCode));
    assert.equal(outcome.resultingState, 'LIVE_LOCAL', String(backendCode));
    assert.ok(contract.PHOTOREAL_FAILURE_CODES.includes(outcome.code), String(backendCode));
  }
});

test('matrix G: the Live panel treats a photoreal failure as bounded, not fatal', () => {
  const panel = code('components/vto/VtoLivePanel.tsx');
  assert.ok(panel.includes('vto-live-photoreal-error'), 'a bounded notice exists');
  assert.ok(
    panel.includes('Live is still running'),
    'the copy must say the session survived',
  );
  // The Live controls are not gated on the absence of a photoreal failure.
  assert.ok(!/photorealFailure\s*\?\s*null\s*:/.test(panel));
});

// ── The harness is provider-inert ───────────────────────────────────────────

test('harness: an active harness cannot spend a real generation', async () => {
  const handoff = loadHandoff({ harnessActive: () => true });
  const outcome = await handoff.buildPhotorealPersonInput(personFrame);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'harness_active');
  assert.equal(outcome.failure.liveSessionRemainsUsable, true);
});

test('harness: the clean-frame rule is checked BEFORE the harness escape', async () => {
  // Otherwise a harness build would stop exercising the rule it exists to
  // help test, and the refusal would be reported as the wrong cause.
  const handoff = loadHandoff({ harnessActive: () => true });
  const outcome = await handoff.buildPhotorealPersonInput(previewFrame);
  assert.equal(outcome.failure.code, 'no_usable_still');
});

// ── Generative governance is untouched ──────────────────────────────────────

test('governance: the handoff contains no provider, endpoint, or network client', () => {
  const source = code('services/vto/vtoPhotorealHandoff.ts');
  for (const pattern of [
    /\bfetch\s*\(/, /supabase/, /\.invoke\s*\(/, /https?:\/\//,
    /apiKey/i, /Authorization/i, /vto-generate/,
  ]) {
    assert.ok(!pattern.test(source), `the bridge must not contain ${pattern}`);
  }
});

test('governance: Live reaches the cloud only through the existing store action', () => {
  // adoptPerson -> setVtoPersonInput -> startVtoGeneration -> requestVtoGeneration
  // is the SAME chain the photo picker uses. A second chain would be a bypass.
  const hook = code('hooks/useVirtualTryOn.ts');
  assert.ok(hook.includes('adoptPerson'), 'the additive action exists');
  assert.ok(
    /adoptPerson\s*=\s*useCallback\(\(person[^)]*\)\s*=>\s*\{\s*setVtoPersonInput\(/.test(hook),
    'adoptPerson must delegate to the existing store, not a new path',
  );
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  assert.ok(sheet.includes('vto.adoptPerson(person)'));
  assert.ok(sheet.includes('vto.generate()'));
});

test('governance: no VTO client or Edge Function file was modified by this lane', () => {
  // The backend may be READ by this lane; it may not be mutated. These are the
  // exact strings that would have to change for a bypass to exist.
  const client = read('services/vto/vtoClient.ts');
  assert.ok(client.includes("export const VTO_EDGE_FUNCTION = 'vto-generate';"));
  assert.ok(client.includes('resolveAuthenticatedFunctionSession'));
  assert.ok(
    client.includes("return { ok: false, code: 'authorization_failed' };"),
    'the client still refuses to invoke without a usable session',
  );
  // And it still sends only the fields it sent before -- no Live provenance,
  // no capture id, no session handle.
  assert.ok(!/live|capture|session/i.test(client.match(/const body: Record<string, unknown> = \{[\s\S]*?\};/)[0]));
});

test('governance: the person source never reaches the server', () => {
  const client = code('services/vto/vtoClient.ts');
  const body = client.match(/const body: Record<string, unknown> = \{[\s\S]*?\};/)[0];
  assert.ok(body.includes('person: { dataUri: args.personDataUri }'));
  assert.ok(!body.includes('source'), 'where the image came from is not sent');
});
