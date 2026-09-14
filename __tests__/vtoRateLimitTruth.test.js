// VTO V3.1 — BLOCK-VTO31-00..10.
//
// THE DEFECT. Three unrelated situations all left `vto-generate` as
// `rate_limited`, and the app rendered every one of them as "You've reached the
// try-on limit for now":
//
//   the actor really did spend their daily allowance   -> true
//   a duplicate request was already in flight          -> FALSE
//   the VENDOR GATEWAY was throttling K Scan           -> FALSE
//
// Two of three told a shopper they had used something up when they had not.
// This suite pins the split, and pins that the split did not disturb the
// billing machinery underneath it.
//
// HOW IT TESTS. `handleVtoRequest` takes its whole authority chain as injected
// dependencies, so the REAL handler runs here against fakes — these are
// behavioural assertions about what the function returns and which reservation
// calls it makes, not source-text matching.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function loadTs(relativePath, requireMap = {}, extraGlobals = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod,
    URL, URLSearchParams, Math, Number, Set, Map, Object, Array, JSON, Date,
    RangeError, Error, TypeError, String, Boolean, RegExp, Promise, Symbol,
    Request, Response, Headers, Blob, FormData, TextEncoder, TextDecoder,
    AbortController, DOMException, setTimeout, clearTimeout, crypto,
    Uint8Array, ArrayBuffer, Buffer, atob, btoa, Infinity, NaN, isNaN,
    ...extraGlobals,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

// ── The real modules under test ─────────────────────────────────────────────

const serverContract = loadTs('supabase/functions/vto-generate/vtoContract.ts');
const clientTypes = loadTs('types/vto.ts');
const clientFailures = loadTs('services/vto/vtoFailures.ts', {
  '../../types/vto': clientTypes,
});
const adapter = loadTs('supabase/functions/vto-generate/providers/aiLabToolsProvider.ts', {
  '../../_shared/net/safeRemoteMedia.ts': {
    assertSafeRemoteMediaUrl: (u) => ({ ok: true, url: String(u) }),
    // The real allowlist, so the garment-fetch content-type gate behaves as it
    // does in production rather than being stubbed permissive.
    ALLOWED_MEDIA_CONTENT_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  },
  '../vtoContract.ts': serverContract,
}, { Deno: { env: { get: () => undefined } } });

const { parseRetryAfterSeconds } = adapter;
const { VTO_RETRY_AFTER_MIN_SECONDS, VTO_RETRY_AFTER_MAX_SECONDS } = serverContract;

// ── A drivable real handler ─────────────────────────────────────────────────

function loadHandler() {
  return loadTs('supabase/functions/vto-generate/vtoHandler.ts', {
    '../_shared/deletion/common.ts': {
      corsHeaders: {},
      json: (body, status) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      requireUser: async () => ({ id: '00000000-0000-4000-8000-00000000beef' }),
      assertAccountActive: async () => {},
      shortUserId: () => 'uid',
    },
    './vtoContract.ts': serverContract,
    './vtoEligibility.ts': loadTs('supabase/functions/vto-generate/vtoEligibility.ts', {
      '../_shared/scanHelpers.ts': loadTs('supabase/functions/_shared/scanHelpers.ts'),
      './vtoContract.ts': serverContract,
    }),
    './vtoFeatureControl.ts': { readVtoFeatureConfig: async () => ({}) },
    './vtoEntitlement.ts': { resolveVtoEntitlement: async () => ({ state: 'active' }) },
    '../_shared/net/safeRemoteMedia.ts': {
      assertSafeRemoteMediaUrl: (u) => ({ ok: true, url: String(u) }),
    },
    './vtoReservation.ts': {
      buildVtoIdempotencyKey: async () => 'k'.repeat(64),
      reserveVtoGeneration: async () => ({ outcome: 'reserved' }),
      completeVtoGeneration: async () => {},
      releaseVtoGeneration: async () => {},
    },
    './vtoResultValidation.ts': {
      validateVtoResultMedia: () => ({ ok: false, detail: 'unused' }),
    },
    './vtoTelemetry.ts': {
      logVtoEvent: () => {},
      dimensionBucket: () => 'x',
      payloadBucket: () => 'x',
    },
    './providers/index.ts': {
      isMockVtoScenario: () => false,
      resolveVtoProvider: () => ({ ok: true, provider: { id: 'p', generate: async () => ({ ok: true }) } }),
    },
  }, { Deno: { env: { get: () => undefined } } });
}

/** A well-formed request the handler will carry all the way to the reservation. */
function goodRequest() {
  const px = 'data:image/png;base64,' + 'A'.repeat(2048);
  return new Request('https://example.test/vto-generate', {
    method: 'POST',
    body: JSON.stringify({
      requestId: 'req-1',
      origin: 'dev_harness',
      garment: {
        imageUrl: 'https://cdn.example.com/g.jpg',
        category: 'top',
        productRef: 'p-1',
      },
      person: { dataUri: px },
    }),
  });
}

async function runHandler(overrides) {
  const { handleVtoRequest } = loadHandler();
  const res = await handleVtoRequest(goodRequest(), {
    readVtoFeatureConfig: async () => ({ enabled: true, supportedCategories: ['top'], provider: 'p' }),
    ...overrides,
  });
  return { status: res.status, body: await res.json() };
}

// ── BLOCK-VTO31-00 / 01 / 02 — the three truths ─────────────────────────────

test('BLOCK-VTO31-00: a real daily-allowance refusal reports quota_exhausted', async () => {
  const { status, body } = await runHandler({
    reserveVtoGeneration: async () => ({ outcome: 'quota_exceeded', used: 10, dailyLimit: 10 }),
  });
  assert.equal(body.error.code, 'quota_exhausted');
  assert.equal(status, 429);
  // This is the ONE code whose copy may speak about the customer's limit.
  assert.match(clientFailures.toVtoFailure('quota_exhausted').message, /try-on limit/i);
});

test('BLOCK-VTO31-01: a duplicate in-flight request reports request_in_flight, never a quota', async () => {
  const { status, body } = await runHandler({
    reserveVtoGeneration: async () => ({ outcome: 'duplicate', priorStatus: 'in_flight' }),
  });
  assert.equal(body.error.code, 'request_in_flight');
  assert.notEqual(body.error.code, 'quota_exhausted');
  assert.equal(status, 429);

  const copy = clientFailures.toVtoFailure('request_in_flight');
  assert.doesNotMatch(copy.message, /limit|quota|allowance/i, 'must not blame the allowance');
  // Not retryable on purpose: a retry button here asks for exactly the second
  // submission idempotency just suppressed.
  assert.equal(copy.retryable, false);
});

test('BLOCK-VTO31-02: a provider gateway 429 reports provider_busy, never a user quota', async () => {
  const { status, body } = await runHandler({
    resolveVtoProvider: () => ({
      ok: true,
      provider: {
        id: 'ailabtools_tryon_clothes_pro',
        generate: async () => ({
          ok: false, failure: 'provider_busy', detail: 'submit_http_429', billable: false,
        }),
      },
    }),
  });
  assert.equal(body.error.code, 'provider_busy');
  assert.notEqual(body.error.code, 'quota_exhausted');
  assert.notEqual(body.error.code, 'rate_limited');
  // A service condition, not a limit on this person.
  assert.equal(status, 503);

  const copy = clientFailures.toVtoFailure('provider_busy');
  assert.doesNotMatch(copy.message, /limit|quota|allowance|you'?ve reached/i);
  assert.match(copy.message, /busy|temporarily/i);
  assert.equal(copy.retryable, true);
});

// ── BLOCK-VTO31-03 / 04 / 05 — Retry-After ──────────────────────────────────

test('BLOCK-VTO31-03: a valid Retry-After is normalized and carried to the response', async () => {
  // delta-seconds
  assert.equal(parseRetryAfterSeconds('120'), 120);
  assert.equal(parseRetryAfterSeconds('  90  '), 90);
  assert.equal(parseRetryAfterSeconds(String(VTO_RETRY_AFTER_MIN_SECONDS)), VTO_RETRY_AFTER_MIN_SECONDS);
  assert.equal(parseRetryAfterSeconds(String(VTO_RETRY_AFTER_MAX_SECONDS)), VTO_RETRY_AFTER_MAX_SECONDS);

  // HTTP-date, resolved against an injected clock
  const now = Date.parse('2026-10-21T07:00:00Z');
  assert.equal(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:02:00 GMT', now), 120);

  // ...and it reaches the governed response body as a bounded integer.
  const { body } = await runHandler({
    resolveVtoProvider: () => ({
      ok: true,
      provider: {
        id: 'ailabtools_tryon_clothes_pro',
        generate: async () => ({
          ok: false, failure: 'provider_busy', detail: 'submit_http_429',
          billable: false, retryAfterSeconds: 42,
        }),
      },
    }),
  });
  assert.equal(body.error.code, 'provider_busy');
  assert.equal(body.error.retryAfterSeconds, 42);
});

test('BLOCK-VTO31-04: no Retry-After means no invented wait', async () => {
  assert.equal(parseRetryAfterSeconds(null), null);
  assert.equal(parseRetryAfterSeconds(undefined), null);
  assert.equal(parseRetryAfterSeconds(''), null);
  assert.equal(parseRetryAfterSeconds('   '), null);

  const { body } = await runHandler({
    resolveVtoProvider: () => ({
      ok: true,
      provider: {
        id: 'ailabtools_tryon_clothes_pro',
        generate: async () => ({
          ok: false, failure: 'provider_busy', detail: 'submit_http_429', billable: false,
        }),
      },
    }),
  });
  assert.equal(body.error.code, 'provider_busy');
  assert.ok(
    !('retryAfterSeconds' in body.error),
    'the field is absent entirely rather than null/0 — a number nobody sent is not guidance',
  );
});

test('BLOCK-VTO31-05: a malformed, hostile or out-of-range Retry-After is discarded', () => {
  const now = Date.parse('2026-10-21T07:00:00Z');
  for (const hostile of [
    'soon', 'NaN', '12abc', '-1', '-9999', '0', '1.5', '1e9', '٣٠',
    '99999999999999999999999999', '9'.repeat(400),
    'Wed, 21 Oct 2020 07:00:00 GMT',   // a date in the past
    'Not, a real date at all',
  ]) {
    assert.equal(
      parseRetryAfterSeconds(hostile, now), null,
      `must discard ${JSON.stringify(hostile.slice(0, 32))}`,
    );
  }
  // Just outside the bound in both directions: discarded, never clamped.
  assert.equal(parseRetryAfterSeconds(String(VTO_RETRY_AFTER_MAX_SECONDS + 1)), null);
  assert.equal(parseRetryAfterSeconds(String(VTO_RETRY_AFTER_MIN_SECONDS - 1)), null);
  // Non-strings cannot crash it.
  for (const notAString of [123, {}, [], true, Symbol('x')]) {
    assert.equal(parseRetryAfterSeconds(notAString), null);
  }
});

// ── BLOCK-VTO31-06 — nothing of the vendor reaches the customer ─────────────

test('BLOCK-VTO31-06: a 429 response carries no provider identity, header or raw body', async () => {
  const { body } = await runHandler({
    resolveVtoProvider: () => ({
      ok: true,
      provider: {
        id: 'ailabtools_tryon_clothes_pro',
        generate: async () => ({
          ok: false, failure: 'provider_busy',
          detail: 'submit_http_429', billable: false, retryAfterSeconds: 30,
        }),
      },
    }),
  });
  const wire = JSON.stringify(body);
  for (const leak of [
    'ailabtools', 'AILabTools', 'rapidapi', 'RapidAPI', 'x-rapidapi',
    '429', 'submit_http', 'try-on-clothes-pro', 'provider_outcome',
    'stage', 'providerDetail', 'Retry-After',
  ]) {
    assert.ok(!wire.includes(leak), `the governed response leaked ${leak}: ${wire}`);
  }
  // Exactly the allowed keys, and nothing else.
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId', 'status']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'retryAfterSeconds', 'retryable']);

  // And no customer-facing copy names a vendor or a status code.
  for (const failureCode of clientTypes.VTO_FAILURE_CODES) {
    const message = clientFailures.toVtoFailure(failureCode).message;
    for (const forbidden of ['429', 'rapidapi', 'ailabtools', 'http', 'gateway', 'provider']) {
      assert.ok(
        !message.toLowerCase().includes(forbidden),
        `copy for ${failureCode} exposes ${forbidden}: ${message}`,
      );
    }
  }
});

// ── BLOCK-VTO31-07 — guidance, not a retry loop ─────────────────────────────

test('BLOCK-VTO31-07: no automatic provider retry was added', () => {
  const adapterSrc = code('supabase/functions/vto-generate/providers/aiLabToolsProvider.ts');
  const handlerSrc = code('supabase/functions/vto-generate/vtoHandler.ts');

  // The SUBMIT is issued exactly once. The only bounded loop in the adapter is
  // the poll loop, which waits on a task that already exists.
  assert.equal(
    (adapterSrc.match(/doFetch\(SUBMIT_URL/g) ?? []).length, 1,
    'exactly one submit call site',
  );
  for (const src of [adapterSrc, handlerSrc]) {
    assert.equal(/setTimeout\([^)]*retryAfter/i.test(src), false, 'retry guidance must not schedule work');
    assert.equal(/sleep\(\s*retryAfter/i.test(src), false);
    assert.equal(/while\s*\([^)]*retryAfter/i.test(src), false);
  }
  // The parsed value is used for reporting only: it is returned/assigned, never
  // awaited or fed to a timer.
  assert.equal(/await[^;]*parseRetryAfterSeconds/.test(adapterSrc), false);
  // The handler re-submits nothing: generate() is called once.
  assert.equal(
    (handlerSrc.match(/selection\.provider\.generate\(/g) ?? []).length, 1,
    'the orchestrator calls the provider exactly once per request',
  );
});

// ── BLOCK-VTO31-08 / 09 — the billing machinery is untouched ────────────────

test('BLOCK-VTO31-08: idempotency key composition is unchanged by this repair', () => {
  const src = code('supabase/functions/vto-generate/vtoReservation.ts');
  const key = src.slice(src.indexOf('export async function buildVtoIdempotencyKey'));
  // The same five canonical inputs, in the same order, and still a DIGEST of
  // the person image rather than its bytes.
  assert.match(
    key,
    /\[input\.userId, input\.productRef, input\.garmentImageUrl, personDigest, generation\]/,
  );
  // Retry timing must not have crept into the identity: a key that varied with
  // a vendor's Retry-After would defeat duplicate suppression entirely.
  for (const forbidden of ['retryAfter', 'Date.now', 'Math.random', 'attempt']) {
    assert.ok(!key.includes(forbidden), `the idempotency key must not depend on ${forbidden}`);
  }
});

test('BLOCK-VTO31-09: a provider 429 still RELEASES the attempt, and a billable failure still settles it', async () => {
  const calls = [];
  const deps = (outcome) => ({
    resolveVtoProvider: () => ({
      ok: true,
      provider: { id: 'ailabtools_tryon_clothes_pro', generate: async () => outcome },
    }),
    releaseVtoGeneration: async () => { calls.push('release'); },
    completeVtoGeneration: async (_u, _k, status) => { calls.push(`complete:${status}`); },
  });

  // Gateway 429: no vendor job was ever created, so the attempt is given back.
  calls.length = 0;
  await runHandler(deps({
    ok: false, failure: 'provider_busy', detail: 'submit_http_429',
    billable: false, retryAfterSeconds: 30,
  }));
  assert.deepEqual(calls, ['release'], 'a non-billable 429 releases and never settles');

  // A failure the vendor DID charge for stays counted — unchanged behaviour.
  calls.length = 0;
  await runHandler(deps({ ok: false, failure: 'generation_failed', billable: true }));
  assert.deepEqual(calls, ['complete:failed'], 'a billable failure still settles as failed');

  // An adapter that forgets to declare billability still counts, as before.
  calls.length = 0;
  await runHandler(deps({ ok: false, failure: 'generation_failed' }));
  assert.deepEqual(calls, ['complete:failed'], 'absent billable still defaults to counted');
});

// ── BLOCK-VTO31-10 — nothing else moved ─────────────────────────────────────

test('BLOCK-VTO31-10: every pre-existing failure state survives, on both sides of the wire', () => {
  const PRE_EXISTING = [
    'invalid_person_input', 'invalid_garment_input', 'unsupported_category',
    'provider_rejected_input', 'provider_moderation', 'provider_timeout',
    'provider_unavailable', 'rate_limited', 'generation_failed', 'invalid_output',
    'authorization_failed', 'entitlement_required', 'feature_disabled',
    'network_failure', 'cancelled', 'unknown',
  ];
  for (const failureCode of PRE_EXISTING) {
    assert.ok(clientTypes.VTO_FAILURE_CODES.includes(failureCode), `client dropped ${failureCode}`);
    assert.ok(serverContract.VTO_FAILURE_CODES.includes(failureCode), `server dropped ${failureCode}`);
    const copy = clientFailures.toVtoFailure(failureCode);
    assert.equal(copy.code, failureCode);
    assert.ok(copy.message.length > 0);
  }
  // The three new codes are additive on both sides.
  for (const added of ['quota_exhausted', 'request_in_flight', 'provider_busy']) {
    assert.ok(clientTypes.VTO_FAILURE_CODES.includes(added));
    assert.ok(serverContract.VTO_FAILURE_CODES.includes(added));
  }
  assert.equal(
    clientTypes.VTO_FAILURE_CODES.length, PRE_EXISTING.length + 3,
    'exactly three codes were added and none removed',
  );
});

test('BLOCK-VTO31-10: the legacy rate_limited code survives but no longer blames the customer', () => {
  // It is still on the wire (an older deployment can emit it) and the handler
  // no longer produces it.
  assert.ok(serverContract.VTO_FAILURE_CODES.includes('rate_limited'));
  const handlerSrc = code('supabase/functions/vto-generate/vtoHandler.ts');
  assert.equal(
    /fail\(\s*'rate_limited'/.test(handlerSrc), false,
    'the handler no longer emits the collapsed code',
  );
  const adapterSrc = code('supabase/functions/vto-generate/providers/aiLabToolsProvider.ts');
  assert.equal(
    /failure:\s*'rate_limited'/.test(adapterSrc), false,
    'the adapter no longer emits the collapsed code',
  );
  // And its copy no longer claims the shopper used something up.
  const legacy = clientFailures.toVtoFailure('rate_limited');
  assert.doesNotMatch(legacy.message, /you'?ve reached|limit|allowance/i);
});

// ── Wiring: the header is actually read off the real Response ───────────────
//
// Every test above proves the PARSER and the ORCHESTRATOR. Neither proves the
// adapter passes `submitResponse.headers` into it — a repair that parsed
// perfectly and was never handed the header would pass all of them. This
// drives the real `generate()` with a fake transport.

function fakeTransport({ submitStatus, submitHeaders, submitBody }) {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8192, 7),
  ]);
  return async (url) => {
    if (String(url).includes('cdn.example.com')) {
      return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
      });
    }
    return new Response(JSON.stringify(submitBody ?? { error_code: 1 }), {
      status: submitStatus,
      headers: { 'content-type': 'application/json', ...(submitHeaders ?? {}) },
    });
  };
}

async function generateAgainst(transport) {
  const provider = adapter.createAiLabToolsProvider({ apiKey: 'test-key', fetchImpl: transport });
  return provider.generate(
    {
      personDataUri: 'data:image/png;base64,' + Buffer.alloc(4096, 3).toString('base64'),
      garmentImageUrl: 'https://cdn.example.com/g.png',
      slot: 'top',
      canonicalCategory: 'top',
    },
    { signal: new AbortController().signal },
  );
}

test('BLOCK-VTO31-03 (wiring): the adapter reads Retry-After off the real submit response', async () => {
  const outcome = await generateAgainst(fakeTransport({
    submitStatus: 429,
    submitHeaders: { 'retry-after': '75' },
  }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure, 'provider_busy');
  assert.equal(outcome.retryAfterSeconds, 75, 'the header reached the parser');
  // Accounting untouched: a gateway refusal created no vendor job.
  assert.equal(outcome.billable, false);
  assert.equal(outcome.detail, 'submit_http_429');
});

test('BLOCK-VTO31-04 (wiring): a 429 with no Retry-After yields provider_busy and no invented wait', async () => {
  const outcome = await generateAgainst(fakeTransport({ submitStatus: 429 }));
  assert.equal(outcome.failure, 'provider_busy');
  assert.equal(outcome.retryAfterSeconds, undefined);
  assert.equal(outcome.billable, false);
});

test('BLOCK-VTO31-05 (wiring): a hostile Retry-After header is dropped, not echoed', async () => {
  for (const hostile of ['-5', 'whenever', '0', '99999999']) {
    const outcome = await generateAgainst(fakeTransport({
      submitStatus: 429,
      submitHeaders: { 'retry-after': hostile },
    }));
    assert.equal(outcome.failure, 'provider_busy', hostile);
    assert.equal(outcome.retryAfterSeconds, undefined, `must not echo ${hostile}`);
  }
});

test('BLOCK-VTO31-02 (wiring): a 401/403 stays provider_unavailable, not provider_busy', async () => {
  // The split must not have widened: only 429 became provider_busy. A
  // subscription refusal is a different condition with different copy.
  for (const status of [401, 403]) {
    const outcome = await generateAgainst(fakeTransport({ submitStatus: status }));
    assert.equal(outcome.failure, 'provider_unavailable', `http ${status}`);
    assert.equal(outcome.billable, false);
  }
  // And a 5xx likewise.
  const outcome = await generateAgainst(fakeTransport({ submitStatus: 503 }));
  assert.equal(outcome.failure, 'provider_unavailable');
});
