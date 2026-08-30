// VTO transport boundary: turning an HTTP outcome into a K Scan failure.
//
// This is the layer where a provider's words could leak into the app, and
// where an unexpected response shape could be mistaken for a result. Both are
// exercised here against controlled invoke responses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule(relative, requireMap = {}) {
  const absPath = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
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
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(absPath)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

const clientTypes = loadModule('types/vto.ts');
const failures = loadModule('services/vto/vtoFailures.ts', { '../../types/vto': clientTypes });

function loadClient(invoke, session = { ok: true, accessToken: 'token' }) {
  return loadModule('services/vto/vtoClient.ts', {
    '../supabaseClient': { supabase: { functions: { invoke: () => {} } } },
    '../authenticatedFunctionSession': {
      resolveAuthenticatedFunctionSession: () => Promise.resolve(session),
    },
    './vtoFailures': failures,
    '../../types/vto': clientTypes,
  });
}

const GARMENT = {
  productRef: 'p1',
  imageUrl: 'https://cdn.example.com/coat.jpg',
  category: 'wool coat',
  brand: null,
  commerceSource: 'example',
};

function args(extra = {}) {
  return {
    requestId: 'vtoreq_1_a',
    origin: 'commerce_product',
    garment: GARMENT,
    personDataUri: 'data:image/jpeg;base64,AAAA',
    ...extra,
  };
}

/** A FunctionsHttpError as supabase-js reports one: the raw Response on
 *  `.context`, with the enum code inside the JSON body. */
function httpError(status, body) {
  return {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: { status, json: () => Promise.resolve(body) },
  };
}

test('a successful response becomes a typed result', async () => {
  const client = loadClient();
  const outcome = await client.requestVtoGeneration(args(), {
    invoke: () =>
      Promise.resolve({
        data: {
          requestId: 'echo',
          status: 'success',
          provider: 'mock',
          result: {
            dataUri: 'data:image/png;base64,AAAA',
            mediaType: 'image/png',
            width: 256,
            height: 320,
            isAiVisualization: true,
            latencyMs: 90,
          },
        },
        error: null,
      }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, 'mock');
  assert.equal(outcome.mediaType, 'image/png');
});

test('the enum code survives a non-2xx; the body does not', async () => {
  const client = loadClient();
  for (const [status, code] of [
    [401, 'authorization_failed'],
    [403, 'entitlement_required'],
    [403, 'feature_disabled'],
    [422, 'unsupported_category'],
    [429, 'rate_limited'],
    [504, 'provider_timeout'],
    [502, 'invalid_output'],
  ]) {
    const outcome = await client.requestVtoGeneration(args(), {
      invoke: () =>
        Promise.resolve({
          data: null,
          error: httpError(status, {
            error: { code, retryable: true },
            debug: 'UPSTREAM SAID: key sk-live-1234 rejected',
          }),
        }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, code);
    assert.equal(Object.prototype.hasOwnProperty.call(outcome, 'debug'), false);
  }
});

test('an unrecognised error code is not passed through', async () => {
  const client = loadClient();
  const outcome = await client.requestVtoGeneration(args(), {
    invoke: () =>
      Promise.resolve({
        data: null,
        error: httpError(500, { error: { code: 'UPSTREAM_QUOTA_EXCEEDED_sk_live_1234' } }),
      }),
  });
  assert.equal(outcome.code, 'network_failure');
});

test('an error with no readable body is a network failure, not an invention', async () => {
  const client = loadClient();
  for (const error of [
    { name: 'FunctionsFetchError', message: 'failed to fetch' },
    { context: { status: 500, json: () => Promise.reject(new Error('consumed')) } },
    { context: {} },
  ]) {
    const outcome = await client.requestVtoGeneration(args(), {
      invoke: () => Promise.resolve({ data: null, error }),
    });
    assert.equal(outcome.code, 'network_failure');
  }
});

test('a 200 carrying a failure envelope is still a failure', async () => {
  const client = loadClient();
  const outcome = await client.requestVtoGeneration(args(), {
    invoke: () =>
      Promise.resolve({
        data: { requestId: 'x', status: 'failed', error: { code: 'generation_failed' } },
        error: null,
      }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'generation_failed');
});

test('a 200 whose result is not usable media is invalid_output', async () => {
  const client = loadClient();
  const bodies = [
    { result: { dataUri: 'https://cdn.example.com/x.png', mediaType: 'image/png' } },
    { result: { dataUri: 'data:image/png;base64,AAAA', mediaType: 'text/html' } },
    { result: {} },
    {},
    null,
    'a string',
  ];
  for (const data of bodies) {
    const outcome = await client.requestVtoGeneration(args(), {
      invoke: () => Promise.resolve({ data, error: null }),
    });
    assert.equal(outcome.ok, false, JSON.stringify(data));
    assert.equal(outcome.code, 'invalid_output');
  }
});

test('a signed-out caller does not spend a round trip to be told 401', async () => {
  let invoked = false;
  const client = loadClient(null, { ok: false, reason: 'signed_out' });
  const outcome = await client.requestVtoGeneration(args(), {
    resolveSession: () => Promise.resolve({ ok: false, reason: 'signed_out' }),
    invoke: () => {
      invoked = true;
      return Promise.resolve({ data: null, error: null });
    },
  });
  assert.equal(outcome.code, 'authorization_failed');
  assert.equal(invoked, false);
});

test('an already-aborted request is cancelled, never sent', async () => {
  const client = loadClient();
  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  const outcome = await client.requestVtoGeneration(args({ signal: controller.signal }), {
    invoke: () => {
      invoked = true;
      return Promise.resolve({ data: null, error: null });
    },
  });
  assert.equal(outcome.code, 'cancelled');
  assert.equal(invoked, false);
});

test('an abort during flight is cancelled, not a failure the user must action', async () => {
  const client = loadClient();
  const controller = new AbortController();
  const outcome = await client.requestVtoGeneration(args({ signal: controller.signal }), {
    invoke: () => {
      controller.abort();
      const err = new Error('Aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    },
  });
  assert.equal(outcome.code, 'cancelled');
});

test('the request body carries no identity and no provider selection', async () => {
  const client = loadClient();
  let sent = null;
  await client.requestVtoGeneration(args(), {
    invoke: (_fn, options) => {
      sent = options.body;
      return Promise.resolve({ data: null, error: null });
    },
  });
  assert.deepEqual(Object.keys(sent).sort(), ['garment', 'origin', 'person', 'requestId']);
  assert.deepEqual(Object.keys(sent.person), ['dataUri']);
  assert.deepEqual(
    Object.keys(sent.garment).sort(),
    ['brand', 'category', 'commerceSource', 'imageUrl', 'productRef'],
  );
});

test('a dev scenario is only sent when the caller asked for one', async () => {
  const client = loadClient();
  let sent = null;
  await client.requestVtoGeneration(args(), {
    invoke: (_fn, options) => {
      sent = options.body;
      return Promise.resolve({ data: null, error: null });
    },
  });
  assert.equal('devScenario' in sent, false);

  await client.requestVtoGeneration(args({ devScenario: 'timeout' }), {
    invoke: (_fn, options) => {
      sent = options.body;
      return Promise.resolve({ data: null, error: null });
    },
  });
  assert.equal(sent.devScenario, 'timeout');
});

test('the client timeout is longer than the server generation ceiling', () => {
  // Otherwise the client gives up first and reports a generic timeout, hiding
  // the server's own classification of what actually failed.
  const handler = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'vto-generate', 'vtoHandler.ts'),
    'utf8',
  );
  const match = /GENERATION_TIMEOUT_MS = ([\d_]+)/.exec(handler);
  assert.ok(match, 'the server ceiling must be discoverable');
  const serverMs = Number(match[1].replace(/_/g, ''));
  const client = loadClient();
  assert.ok(
    client.VTO_INVOKE_TIMEOUT_MS > serverMs,
    `client ${client.VTO_INVOKE_TIMEOUT_MS}ms must exceed server ${serverMs}ms`,
  );
});
