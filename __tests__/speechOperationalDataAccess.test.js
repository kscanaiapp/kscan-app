const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture({ accountError = false, summary = {}, summaryError = null,
  reserve = { allowed: false, reason: 'disabled' }, reserveError = null, secret = 'fixture-service-key' } = {}) {
  let dependencies;
  const calls = [];
  const actorClient = {
    auth: { getUser: async () => ({ data: { user: { id: 'actor-a', is_anonymous: true } }, error: null }) },
    rpc: async (name) => { calls.push({ boundary: 'actor', name }); return { data: summary, error: summaryError }; },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { account_status: 'active' }, error: accountError ? new Error('database unavailable') : null,
    }) }) }) }),
  };
  const serverClient = { rpc: async (name, args) => {
    calls.push({ boundary: 'server', name, args }); return { data: reserve, error: reserveError };
  } };
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../supabase/functions/stylist-speech/index.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports,
    Deno: { env: { get: (name) => ({ SUPABASE_URL: 'https://fixture.invalid',
      SUPABASE_ANON_KEY: 'fixture-public-key', SUPABASE_SERVICE_ROLE_KEY: secret })[name] }, serve: () => {} },
    require: (name) => {
      if (name === './handler.ts') return { createStylistSpeechHandler: (value) => { dependencies = value; return () => {}; } };
      assert.equal(name, 'npm:@supabase/supabase-js@2.105.4');
      return { createClient: (_url, key, options) => {
        if (key === 'fixture-public-key') { assert.equal(options.global.headers.Authorization, 'Bearer fixture-user-token'); return actorClient; }
        assert.equal(key, secret); assert.equal(options.global, undefined); return serverClient;
      } };
    },
  });
  return { access: dependencies.createDataAccess('Bearer fixture-user-token'), calls };
}

test('Speech account query errors and anonymous identities remain explicit', async () => {
  assert.equal(await fixture({ accountError: true }).access.getAccountStatus('actor-a'), null);
  assert.equal((await fixture().access.getAuthenticatedActor()).isAnonymous, true);
});

test('Speech cost mutations use only service client and verified server actor/reference cost arguments', async () => {
  const f = fixture();
  await f.access.reserveSpeechRequest('actor-a', 'a'.repeat(64), 25);
  await f.access.finishSpeechRequest('actor-a', 'reservation-a', false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].boundary, 'server'); assert.equal(f.calls[1].boundary, 'server');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)), {
    p_user_id: 'actor-a', p_fingerprint: 'a'.repeat(64), p_characters: 25,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].args)), {
    p_user_id: 'actor-a', p_reservation_id: 'reservation-a', p_succeeded: false,
  });
});

test('missing service credentials, database errors and invalid reservation result fail closed', async () => {
  for (const options of [{ secret: '' }, { reserveError: new Error('db') }, { reserve: null }, { reserve: { allowed: 'true' } }]) {
    await assert.rejects(fixture(options).access.reserveSpeechRequest('actor-a', 'a'.repeat(64), 25), /cost controls.*unavailable/);
  }
});
