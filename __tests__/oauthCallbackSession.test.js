const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadService(defaultClient) {
  const filename = path.join(ROOT, 'services/oauthCallbackSession.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    Error,
    Math,
    Promise,
    exports: module.exports,
    module,
    require: (id) => {
      if (id === './supabaseClient') return { supabase: defaultClient };
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename });
  return module.exports;
}

test('duplicate Android callback consumers share one PKCE exchange and one session result', async () => {
  let exchangeCount = 0;
  let releaseExchange;
  const client = {
    auth: {
      exchangeCodeForSession: () => {
        exchangeCount += 1;
        return new Promise((resolve) => {
          releaseExchange = () => resolve({
            data: { session: { access_token: 'opaque', user: { id: 'private' } } },
            error: null,
          });
        });
      },
      getSession: async () => ({ data: { session: null }, error: null }),
      setSession: async () => ({ data: { session: null }, error: null }),
    },
  };
  const { completeOAuthCallbackSession } = loadService(client);
  const parsed = { code: 'private-code', hasSessionTokens: false };

  const browserConsumer = completeOAuthCallbackSession(parsed, client);
  const routeConsumer = completeOAuthCallbackSession(parsed, client);

  assert.strictEqual(browserConsumer, routeConsumer);
  assert.equal(exchangeCount, 1);
  releaseExchange();
  const [browserResult, routeResult] = await Promise.all([browserConsumer, routeConsumer]);
  assert.equal(browserResult.error, null);
  assert.strictEqual(browserResult, routeResult);
  assert.equal(exchangeCount, 1);
});

test('a distinct later callback is exchanged independently', async () => {
  let exchangeCount = 0;
  const client = {
    auth: {
      exchangeCodeForSession: async () => ({
        data: { session: { access_token: `opaque-${++exchangeCount}` } },
        error: null,
      }),
      getSession: async () => ({ data: { session: null }, error: null }),
      setSession: async () => ({ data: { session: null }, error: null }),
    },
  };
  const { completeOAuthCallbackSession } = loadService(client);

  await completeOAuthCallbackSession({ code: 'code-one' }, client);
  await completeOAuthCallbackSession({ code: 'code-two' }, client);

  assert.equal(exchangeCount, 2);
});

test('a callback without code or complete tokens is rejected without touching auth', async () => {
  let calls = 0;
  const client = {
    auth: {
      exchangeCodeForSession: async () => { calls += 1; },
      getSession: async () => { calls += 1; },
      setSession: async () => { calls += 1; },
    },
  };
  const { completeOAuthCallbackSession } = loadService(client);
  const result = await completeOAuthCallbackSession({}, client);

  assert.equal(result.source, 'missing');
  assert.ok(result.error);
  assert.equal(result.session, null);
  assert.equal(calls, 0);
});

test('a sequential duplicate reuses the accepted stored session without exchanging again', async () => {
  let exchangeCount = 0;
  let getSessionCount = 0;
  const acceptedSession = { access_token: 'opaque-session' };
  const client = {
    auth: {
      exchangeCodeForSession: async () => {
        exchangeCount += 1;
        return { data: { session: acceptedSession }, error: null };
      },
      getSession: async () => {
        getSessionCount += 1;
        return { data: { session: acceptedSession }, error: null };
      },
      setSession: async () => ({ data: { session: null }, error: null }),
    },
  };
  const { completeOAuthCallbackSession } = loadService(client);
  const parsed = { code: 'same-code' };

  await completeOAuthCallbackSession(parsed, client);
  const replay = await completeOAuthCallbackSession(parsed, client);

  assert.equal(replay.error, null);
  assert.equal(exchangeCount, 1);
  assert.equal(getSessionCount, 1);
});
