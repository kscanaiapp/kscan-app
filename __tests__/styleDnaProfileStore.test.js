// Build 34 / Track B integration closure — Signature Style RPC client contract.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(rel, requireMap = {}) {
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, {
    console, exports: module.exports, module, Date, Math, Number, Object, Array, JSON, String, Boolean, Promise,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require in ${rel}: ${id}`);
    },
  }, { filename: rel });
  return module.exports;
}

const types = loadTsModule('supabase/functions/_shared/styleDna/styleDnaProfileTypes.ts');
const store = loadTsModule('supabase/functions/_shared/styleDna/styleDnaProfileStore.ts', {
  './styleDnaProfileTypes.ts': types,
});

function validProfile(overrides = {}) {
  return {
    evidenceCount: 1,
    colorFrequency: [{ value: 'black', count: 1 }],
    categoryFrequency: [{ value: 'Outerwear', count: 1 }],
    garmentTypeFrequency: [{ value: 'jacket', count: 1 }],
    brandFrequency: [{ value: 'Acme', count: 1 }],
    materialFrequency: [{ value: 'nylon', count: 1 }],
    ...overrides,
  };
}

function response(overrides = {}) {
  return {
    user_id: 'user-A',
    profile_version: 1,
    evidence_revision: '2026-08-30T00:00:00.000Z:1',
    derived_at: '2026-08-30T00:00:00.000Z',
    profile_data: validProfile(),
    recomputed: true,
    ...overrides,
  };
}

test('the store requests the zero-argument trusted recomputation RPC', async () => {
  const calls = [];
  const result = await store.getOrRecomputeStyleDnaProfile({
    supabase: {
      rpc: (fn, args) => {
        calls.push({ fn, args });
        return Promise.resolve({ data: [response()], error: null });
      },
    },
  });

  assert.deepEqual(calls, [{ fn: 'recompute_signature_style', args: {} }]);
  assert.equal(result.ok, true);
  assert.equal(result.recomputed, true);
  assert.equal(result.profile.userId, 'user-A');
});

test('a reused profile is returned without a client-authored evidence decision', async () => {
  const result = await store.getOrRecomputeStyleDnaProfile({
    supabase: { rpc: () => Promise.resolve({ data: [response({ recomputed: false })], error: null }) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recomputed, false);
});

test('a malformed server response remains unavailable to Elise', async () => {
  const result = await store.getOrRecomputeStyleDnaProfile({
    supabase: { rpc: () => Promise.resolve({ data: [response({ profile_data: { evidenceCount: 9999 } })], error: null }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'profile_recompute_failed');
  assert.equal(result.profile, null);
});

test('a recomputation error falls back safely', async () => {
  const result = await store.getOrRecomputeStyleDnaProfile({
    supabase: { rpc: () => Promise.resolve({ data: null, error: { message: 'denied' } }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'profile_recompute_failed');
});
