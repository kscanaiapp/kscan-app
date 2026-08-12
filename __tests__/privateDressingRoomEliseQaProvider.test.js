// Controlled development-only Elise provider (Build 3 Phase 4, Commit 6).
//
// This seam exists so device QA can exercise the success, clarification, race,
// cancellation and timeout paths before the backend is deployed. That makes the
// question "could this ever route production traffic to a mock?" the only
// question worth testing hard, so these suites are written to try to make it
// happen:
//
//   * a release runtime must resolve the real provider no matter what the QA
//     variable says
//   * the QA variable alone must not be enough
//   * __DEV__ alone must not be enough
//   * Phase 4 OFF must never instantiate it
//   * it must use the production request and response contracts, and must not
//     bypass the response validator
//   * it must persist nothing
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const observabilityStub = require('./helpers/observabilityStub');

const ROOT = path.resolve(__dirname, '..');
const QA_PATH = 'services/privateDressingRoomEliseQaProvider.ts';
const CLIENT_PATH = 'services/privateDressingRoomEliseClient.ts';

/**
 * Loads the QA module (and its client) under a chosen runtime.
 *
 * `dev` controls `__DEV__` and `env` controls process.env, so the four
 * combinations of the dual gate can each be constructed exactly.
 */
function loadUnder({ dev, env = {} }) {
  const cache = new Map();
  const supabaseCalls = [];

  function load(relPath) {
    if (cache.has(relPath)) return cache.get(relPath);
    const filename = path.join(ROOT, relPath);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    const mod = { exports: {} };
    const dirname = path.dirname(filename);
    const localRequire = (specifier) => {
      if (specifier === './observability') return observabilityStub;
      if (specifier === 'expo-crypto') {
        return { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 17) % 256) };
      }
      if (specifier.startsWith('.')) {
        let resolved = path.resolve(dirname, specifier);
        for (const ext of ['', '.ts', '.js']) {
          if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
            resolved += ext;
            break;
          }
        }
        const rel = path.relative(ROOT, resolved).replace(/\\/g, '/');
        if (/services\/supabaseClient(\.[tj]s)?$/.test(rel)) {
          return {
            supabase: {
              functions: {
                invoke: (name, options) => {
                  // Recorded so a test can prove the REAL provider was chosen.
                  supabaseCalls.push({ name, body: options?.body });
                  return Promise.resolve({ data: null, error: null });
                },
              },
            },
          };
        }
        return load(rel);
      }
      throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
    };
    const sandbox = {
      exports: mod.exports,
      module: mod,
      require: localRequire,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout,
      clearTimeout,
      AbortController,
      process: { env },
      JSON,
      Promise,
      Object,
      Array,
      String,
      Number,
      Boolean,
      RegExp,
      Math,
      Error,
      __DEV__: dev,
    };
    vm.createContext(sandbox);
    new vm.Script(output, { filename }).runInContext(sandbox);
    cache.set(relPath, mod.exports);
    return mod.exports;
  }

  return { qa: load(QA_PATH), client: load(CLIENT_PATH), supabaseCalls };
}

const ARMED = { EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_QA_PROVIDER: 'controlled' };

const REQ = '3f9a2b1c8d7e6f5a4b3c2d1e0f9a8b7c';
function occasionBody(instruction) {
  return {
    schemaVersion: 'private-dressing-room-elise-v1',
    requestId: REQ,
    intent: 'interpret_occasion',
    instruction,
  };
}
function anchorBody(instruction) {
  return {
    schemaVersion: 'private-dressing-room-elise-v1',
    requestId: REQ,
    intent: 'build_around_item',
    instruction,
    anchorRef: 'item_3f9a2b1c_1',
    candidates: [
      { ref: 'item_3f9a2b1c_1', slot: 'outerwear', category: 'Outerwear', clothingType: 'Blazer', isAnchor: true },
      { ref: 'item_3f9a2b1c_2', slot: 'footwear', category: 'Shoes', color: 'black' },
    ],
  };
}

// ── The gate ──────────────────────────────────────────────────────────────────

test('a release runtime resolves the real provider whatever the QA variable says', async () => {
  for (const env of [
    ARMED,
    { EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_QA_PROVIDER: 'CONTROLLED' },
    { EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_QA_PROVIDER: 'true' },
    { EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_QA_PROVIDER: '1' },
  ]) {
    const { qa, client, supabaseCalls } = loadUnder({ dev: false, env });
    assert.equal(qa.isControlledEliseProviderEnabled(), false, `${JSON.stringify(env)} must not arm`);
    assert.equal(qa.createControlledEliseInvoke(), null, 'release must not produce a provider');

    // And the factory really does hand back production.
    const invoke = client.resolveEliseInvoke();
    await invoke('style-outfit-generate', { body: occasionBody('qa supported occasion') });
    assert.equal(supabaseCalls.length, 1, 'the real Supabase provider must have been called');
    assert.equal(supabaseCalls[0].name, 'style-outfit-generate');
  }
});

test('__DEV__ alone does not arm the seam', () => {
  for (const env of [{}, { EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_QA_PROVIDER: '' },
    { EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_QA_PROVIDER: 'mock' }]) {
    const { qa } = loadUnder({ dev: true, env });
    assert.equal(qa.isControlledEliseProviderEnabled(), false);
    assert.equal(qa.createControlledEliseInvoke(), null);
  }
});

test('the QA variable alone does not arm the seam', () => {
  const { qa } = loadUnder({ dev: false, env: ARMED });
  assert.equal(qa.isControlledEliseProviderEnabled(), false);
  assert.equal(qa.createControlledEliseInvoke(), null);
});

test('both gates together arm it, and only then', async () => {
  const { qa, client, supabaseCalls } = loadUnder({ dev: true, env: ARMED });
  assert.equal(qa.isControlledEliseProviderEnabled(), true);
  const controlled = qa.createControlledEliseInvoke();
  assert.equal(typeof controlled, 'function');

  const invoke = client.resolveEliseInvoke();
  const result = await invoke('style-outfit-generate', { body: occasionBody('qa supported occasion') });
  assert.equal(supabaseCalls.length, 0, 'the real provider must NOT be called when armed');
  assert.equal(result.data.schemaVersion, 'private-dressing-room-elise-v1');
});

test('the scenario bodies sit behind an inline __DEV__ literal', () => {
  // A FUNCTION CALL cannot be folded by Metro; only an inline literal can. An
  // expo export proved the earlier isDevRuntime() form left the branch intact.
  // Note this asserts foldability of the response BUILDER, not absence of the
  // trigger strings — those are exported data and do remain in the bundle,
  // inert, because __DEV__ is false and the factory can then only return null.
  const source = fs.readFileSync(path.join(ROOT, QA_PATH), 'utf8');
  assert.ok("const SCENARIOS = typeof __DEV__ !== 'undefined' && __DEV__ === true".length > 0 && source.includes("const SCENARIOS = typeof __DEV__ !== 'undefined' && __DEV__ === true"),
    "the scenario table must sit behind an INLINE __DEV__ literal, not a function call");
  assert.match(source, /: null;/);
  // And the gate checks __DEV__ before it ever reads the variable.
  const gate = source.slice(source.indexOf('export function isControlledEliseProviderEnabled'));
  assert.ok(
    gate.indexOf('isDevRuntime()') < gate.indexOf('process.env'),
    '__DEV__ must be checked before the variable is read',
  );
});

test('the QA variable is absent from every build profile and env file', () => {
  const eas = fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8');
  assert.equal(eas.includes('ELISE_QA_PROVIDER'), false, 'no EAS profile may carry it');
  for (const file of ['.env.example', '.env.e2e.example']) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    assert.equal(
      fs.readFileSync(full, 'utf8').includes('ELISE_QA_PROVIDER'),
      false,
      `${file} must not carry it`,
    );
  }
});

// ── Placement ─────────────────────────────────────────────────────────────────

test('the seam lives at the provider boundary and nowhere else', () => {
  // Mock behaviour must not leak into the route, hook, stores, composer, or the
  // Edge Function dispatch.
  for (const file of [
    'app/stylist/dressing-room/index.tsx',
    'hooks/usePrivateDressingRoom.ts',
    'services/privateDressingRoomInteractionStore.ts',
    'services/privateDressingRoomComposer.ts',
    'services/privateDressingRoomEliseOrchestration.ts',
    'supabase/functions/style-outfit-generate/index.ts',
    'supabase/functions/style-outfit-generate/privateDressingRoomEliseHandler.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(source.includes('QaProvider'), false, `${file} must not reference the QA provider`);
    assert.equal(source.includes('ELISE_QA'), false, `${file} must not reference QA scenarios`);
    assert.equal(source.includes('qa supported occasion'), false, `${file} must not know QA triggers`);
  }
  // Exactly one module selects a provider.
  const client = fs.readFileSync(path.join(ROOT, CLIENT_PATH), 'utf8');
  assert.match(client, /export function resolveEliseInvoke/);
  assert.equal((client.match(/createControlledEliseInvoke\(\)/g) ?? []).length, 1);
});

test('production dispatch does not recognise the QA triggers', () => {
  const handler = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/style-outfit-generate/privateDressingRoomEliseHandler.ts'),
    'utf8',
  );
  for (const trigger of ['qa supported occasion', 'qa clarification', 'qa timeout', 'qa unknown alias']) {
    assert.equal(handler.includes(trigger), false, `the Edge Function must not know "${trigger}"`);
  }
});

// ── Contracts and validation ──────────────────────────────────────────────────

test('the controlled provider returns bodies the PRODUCTION validator judges', async () => {
  const { qa, client } = loadUnder({ dev: true, env: ARMED });
  const contract = loadUnder({ dev: true, env: ARMED }).client; // same realm helpers
  void contract;
  const controlled = qa.createControlledEliseInvoke();

  // A success validates and reaches the caller as a response.
  const ok = await client.sendEliseRequest({
    plan: { requestId: REQ, body: occasionBody('qa supported occasion'), aliases: new Map() },
    intent: 'interpret_occasion',
    invoke: controlled,
  });
  assert.equal(ok.kind, 'response');
  assert.equal(ok.response.status, 'success');
  assert.equal(ok.response.normalizedOccasion, 'Dinner');

  // "qa unknown alias" is a hostile-shaped success. The production validator —
  // not the mock — is what rejects it.
  const aliases = new Map([['item_3f9a2b1c_1', 'closet-1'], ['item_3f9a2b1c_2', 'closet-2']]);
  const hostile = await client.sendEliseRequest({
    plan: { requestId: REQ, body: anchorBody('qa unknown alias'), aliases },
    intent: 'build_around_item',
    invoke: controlled,
  });
  assert.equal(hostile.kind, 'failed', 'an unauthorized alias must fail closed');

  // "qa backend unavailable" is read as capability unavailable, not reinterpreted.
  const unavailable = await client.sendEliseRequest({
    plan: { requestId: REQ, body: occasionBody('qa backend unavailable'), aliases: new Map() },
    intent: 'interpret_occasion',
    invoke: controlled,
  });
  assert.equal(unavailable.kind, 'capability_unavailable');
});

test('every documented scenario is implemented and reachable', async () => {
  const { qa } = loadUnder({ dev: true, env: ARMED });
  const controlled = qa.createControlledEliseInvoke();
  assert.deepEqual(JSON.parse(JSON.stringify([...qa.ELISE_QA_SCENARIOS])), [
    'qa supported occasion',
    'qa clarification',
    'qa unsupported',
    'qa backend unavailable',
    'qa safe failure',
    'qa unknown alias',
    'qa delayed response a',
    'qa immediate response b',
    'qa timeout',
  ]);

  const statuses = {};
  for (const scenario of qa.ELISE_QA_SCENARIOS) {
    if (scenario === 'qa timeout' || scenario === 'qa delayed response a') continue;
    const { data } = await controlled('style-outfit-generate', { body: occasionBody(scenario) });
    statuses[scenario] = data && data.status ? data.status : 'legacy-shaped';
  }
  assert.equal(statuses['qa supported occasion'], 'success');
  assert.equal(statuses['qa clarification'], 'clarification_required');
  assert.equal(statuses['qa unsupported'], 'unsupported');
  assert.equal(statuses['qa safe failure'], 'safe_failure');
  assert.equal(statuses['qa unknown alias'], 'success');
  assert.equal(statuses['qa backend unavailable'], 'legacy-shaped');
  assert.equal(statuses['qa immediate response b'], 'success');
});

test('the delayed scenario is delayed, and cancellable', async () => {
  const { qa } = loadUnder({ dev: true, env: ARMED });
  const controlled = qa.createControlledEliseInvoke();
  assert.ok(qa.ELISE_QA_DELAY_MS >= 2000, 'long enough to supersede by hand on a device');

  // Cancellation resolves promptly rather than waiting out the delay.
  const controller = new AbortController();
  const started = Date.now();
  const promise = controlled('style-outfit-generate', {
    body: occasionBody('qa delayed response a'),
    signal: controller.signal,
  });
  controller.abort();
  const result = await promise;
  assert.ok(Date.now() - started < qa.ELISE_QA_DELAY_MS, 'abort must not wait out the delay');
  assert.ok(result.error, 'an aborted controlled call reports an error, not a success');
});

test('the timeout scenario never settles on its own', async () => {
  const { qa } = loadUnder({ dev: true, env: ARMED });
  const controlled = qa.createControlledEliseInvoke();
  const controller = new AbortController();
  let settled = false;
  const promise = controlled('style-outfit-generate', {
    body: occasionBody('qa timeout'),
    signal: controller.signal,
  }).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false, 'it must wait for the caller to give up');
  controller.abort();
  await promise;
  assert.equal(settled, true);
});

// ── Request inspection and privacy ────────────────────────────────────────────

test('the inspection reports the sanitized shape and a privacy verdict', () => {
  const { qa } = loadUnder({ dev: true, env: ARMED });
  const clean = qa.inspectEliseQaRequest(anchorBody('qa supported occasion'));
  assert.equal(clean.schemaVersion, 'private-dressing-room-elise-v1');
  assert.equal(clean.intent, 'build_around_item');
  assert.equal(clean.candidateCount, 2);
  assert.equal(clean.aliasFormat, 'item_<fragment>_1');
  assert.ok(clean.bodyBytes > 0);
  assert.equal(clean.forbiddenFieldsFound.length, 0);
  assert.equal(clean.privacy, 'PASS');

  // And it actually catches a leak rather than always saying PASS.
  const leaky = qa.inspectEliseQaRequest({
    ...anchorBody('x'),
    actorId: 'actor-1',
    accessToken: 'ey.token',
  });
  assert.equal(leaky.privacy, 'FAIL');
  assert.ok(leaky.forbiddenFieldsFound.includes('actorId'));
  assert.ok(leaky.forbiddenFieldsFound.includes('accessToken'));
});

test('the controlled provider persists nothing and reaches no network', () => {
  const source = fs.readFileSync(path.join(ROOT, QA_PATH), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [
    /\bAsyncStorage\b/,
    /\bSecureStore\b/,
    /\bFileSystem\b/,
    /\bsetItem\s*\(/,
    /\bfetch\s*\(/,
    /\bsupabase\b/,
    /\bcreateClient\b/,
    /https?:\/\//,
  ]) {
    assert.doesNotMatch(code, forbidden, `QA provider matches ${forbidden}`);
  }
});

test('Phase 4 OFF never instantiates the controlled provider', () => {
  // The orchestration layer returns before any transport when the flag is off,
  // so no provider — controlled or real — is constructed.
  const orchestration = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomEliseOrchestration.ts'),
    'utf8',
  );
  const code = orchestration.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const entry of ['askElise', 'interpretOccasion', 'buildAroundItem', 'makeMoreCasual']) {
    const start = code.indexOf(`export async function ${entry}`);
    if (start < 0) continue;
    const body = code.slice(start, start + 420);
    assert.match(body, /if \(!deps\.eliseEnabled\) return/, `${entry} must return before any transport`);
    assert.ok(
      body.indexOf('eliseEnabled') < (body.indexOf('sendEliseRequest') === -1 ? Infinity : body.indexOf('sendEliseRequest')),
      `${entry} must check the flag before sending`,
    );
  }
});
