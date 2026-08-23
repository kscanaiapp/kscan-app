'use strict';

// Coverage for services/metaWearableRequestCredentials.ts and the wiring that
// consumes it.
//
// WHY THIS FILE EXISTS. wearable-bridge is served through @supabase/server's
// `withSupabase({ auth: ['publishable', 'secret'] })`. That gate compares the
// request's `apikey` HEADER against the project's publishable/secret keys and
// nothing else — it does not accept the project's legacy `eyJ…` anon key, and
// it ignores the Authorization header when deciding. Confirmed against K Scan
// AI Staging on 2026-08-23:
//
//   apikey=<legacy anon>    -> 401 {"code":"INVALID_CREDENTIALS"}
//   apikey=sb_publishable_… -> 200 {"ticket":{…}}
//
// Every EAS profile ships the legacy anon key, so before this fix every single
// wearable-bridge call from the app 401'd before any operation ran and pairing
// could never complete. These tests pin the two things that prevent that from
// coming back silently: the key SHAPE is validated on the device, and the four
// wearable calls actually send an explicit apikey header.
//
// Like metaWearableDevice.test.js, the module under test is loaded in a sandbox
// whose `require` throws, so adding a runtime import to it fails loudly instead
// of quietly making the rule device-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'services', 'metaWearableRequestCredentials.ts');
const COMPANION_SRC = path.join(__dirname, '..', 'services', 'metaWearableCompanion.ts');

function loadModule() {
  const output = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: (id) => {
      throw new Error(`Unexpected runtime require in metaWearableRequestCredentials.ts: ${id}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(output, sandbox, { filename: 'metaWearableRequestCredentials.ts' });
  return mod.exports;
}

const M = loadModule();

const LEGACY_ANON_SHAPE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.sig';

test('a modern publishable key is accepted and becomes the apikey header', () => {
  assert.equal(M.wearableCredentialFailure('sb_publishable_ABC123'), null);
  const headers = M.wearableInvokeHeaders('sb_publishable_ABC123');
  // Compared field-wise, not with deepStrictEqual: the module runs in a vm
  // realm, so its object literals do not share this realm's Object prototype.
  assert.deepEqual(Object.keys(headers), ['apikey']);
  assert.equal(headers.apikey, 'sb_publishable_ABC123');
});

test('surrounding whitespace does not defeat the key (a common .env artefact)', () => {
  assert.equal(M.wearableCredentialFailure('  sb_publishable_ABC123\n'), null);
  assert.equal(M.wearableInvokeHeaders('  sb_publishable_ABC123\n').apikey, 'sb_publishable_ABC123');
});

test('THE DEFECT: a legacy anon JWT is rejected on-device, not on the wire', () => {
  // This is the exact value every EAS profile ships as
  // EXPO_PUBLIC_SUPABASE_ANON_KEY. Sending it produced a 401
  // INVALID_CREDENTIALS from wearable-bridge with no usable diagnosis.
  assert.equal(M.wearableCredentialFailure(LEGACY_ANON_SHAPE), 'WEARABLE_KEY_WRONG_FORMAT');
});

test('an unset or blank key fails loudly instead of producing an opaque 401', () => {
  for (const value of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(
      M.wearableCredentialFailure(value),
      'WEARABLE_KEY_NOT_CONFIGURED',
      `expected rejection for ${JSON.stringify(value)}`,
    );
  }
});

test('a service-role / secret key is never accepted as the wearable apikey', () => {
  // Belt-and-braces: the gate would accept a secret key, but a client build
  // must never carry one, so the device-side rule refuses it outright.
  assert.equal(M.wearableCredentialFailure('sb_secret_DEADBEEF'), 'WEARABLE_KEY_WRONG_FORMAT');
});

test('the non-narrowing API shape is deliberate — this project builds without strict', () => {
  // strictNullChecks is off (tsconfig extends expo/tsconfig.base, which does
  // not enable `strict`), so an `{ ok: true } | { ok: false }` union would NOT
  // narrow at the call site and `credentials.code` would be a type error. The
  // nullable-code shape is what keeps this checkable.
  assert.equal(typeof M.wearableCredentialFailure, 'function');
  assert.equal(typeof M.wearableInvokeHeaders, 'function');
  assert.equal(M.resolveWearableInvokeHeaders, undefined);
});

test('failure descriptions name the env var and never echo key material', () => {
  for (const code of ['WEARABLE_KEY_NOT_CONFIGURED', 'WEARABLE_KEY_WRONG_FORMAT']) {
    const message = M.describeWearableCredentialFailure(code);
    assert.match(message, /EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
    assert.ok(!message.includes(LEGACY_ANON_SHAPE), 'description leaked key material');
  }
});

// ---------------------------------------------------------------------------
// Wiring. Source-level assertions, because the companion module cannot be
// loaded off-device (expo-crypto, AsyncStorage, the Supabase client). They are
// deliberately narrow: they assert the header is attached to the shared invoke
// wrapper that ALL four wearable functions go through, so a new call site
// cannot silently bypass it.
// ---------------------------------------------------------------------------

const companion = fs.readFileSync(COMPANION_SRC, 'utf8');

test('the shared wearable invoke wrapper attaches the resolved apikey header', () => {
  assert.match(companion, /wearableCredentialFailure\(publishableKey\)/);
  assert.match(companion, /headers:\s*wearableInvokeHeaders\(publishableKey\)/);
});

test('every wearable Edge Function call goes through that one wrapper', () => {
  // If a call site ever reaches supabase.functions.invoke directly it would
  // send the legacy anon key again and 401 — so there must be exactly one
  // invoke in this module.
  const invocations = companion.match(/supabase\.functions\.invoke\(/g) ?? [];
  assert.equal(invocations.length, 1, 'expected exactly one supabase.functions.invoke call site');
});

test('the candidate EAS profile actually sets a publishable key', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eas.json'), 'utf8'));
  const env = eas.build['meta-physical-candidate'].env;
  assert.equal(env.EXPO_PUBLIC_META_WEARABLE_CANDIDATE_ENABLED, 'true');
  assert.equal(
    M.wearableCredentialFailure(env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
    null,
    'meta-physical-candidate ships a key wearable-bridge would reject',
  );
});

test('no profile that enables the Meta candidate lacks a usable wearable key', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eas.json'), 'utf8'));
  for (const [name, profile] of Object.entries(eas.build)) {
    const env = profile.env ?? {};
    if (env.EXPO_PUBLIC_META_WEARABLE_CANDIDATE_ENABLED !== 'true') continue;
    assert.equal(
      M.wearableCredentialFailure(env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
      null,
      `profile "${name}" enables Meta without a publishable key`,
    );
  }
});
