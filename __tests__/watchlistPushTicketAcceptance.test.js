// B35-W1: malformed Expo HTTP-200 tickets must not become notification successes.
// Exercises actual production pushDelivery.ts through TypeScript transpilation and
// controlled fetch. No provider call, device token, customer data or paid service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = path.resolve(__dirname, '..', 'supabase/functions/commerce-watch-refresh/pushDelivery.ts');
const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const event = {
  watchId: '11111111-1111-4111-8111-111111111111',
  eventType: 'target_price_reached',
  displayTitle: 'Saved tee',
  priceText: 'USD 19',
};

function adapter(payload, status = 200) {
  let requests = 0;
  const ctx = {
    exports: {},
    Deno: { env: { get: () => undefined } },
    fetch: async (_url, _init) => {
      requests++;
      return { ok: status >= 200 && status < 300, status, json: async () => payload };
    },
  };
  vm.runInNewContext(compiled, ctx, { filename: source, timeout: 5_000 });
  return { send: () => ctx.exports.sendWatchPush('ExpoPushToken[synthetic]', event), requests: () => requests };
}

for (const [label, payload] of [
  ['null response', null],
  ['missing data', {}],
  ['empty ticket array', { data: [] }],
  ['null ticket', { data: [null] }],
  ['unknown ticket status', { data: [{ status: 'pending', id: 'ticket-1' }] }],
  ['accepted ticket missing id', { data: [{ status: 'ok' }] }],
  ['accepted empty id', { data: [{ status: 'ok', id: '  ' }] }],
  ['multiple tickets for one push', { data: [{ status: 'ok', id: 'one' }, { status: 'ok', id: 'two' }] }],
]) {
  test('malformed Expo 200 ' + label + ' is rejected without invented acceptance', async () => {
    const target = adapter(payload);
    const result = await target.send();
    assert.equal(target.requests(), 1);
    assert.equal(result.attempted, true);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'ticket_error');
    assert.equal(result.ticketId, undefined);
    assert.equal(result.tokenInvalid, undefined);
  });
}

test('valid accepted ticket retains its id for deferred receipt tracking', async () => {
  const result = await adapter({ data: [{ status: 'ok', id: ' ticket-123 ' }] }).send();
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.ticketId, 'ticket-123');
});

test('Expo DeviceNotRegistered error preserves exact-route retirement authority', async () => {
  const result = await adapter({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }).send();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DeviceNotRegistered');
  assert.equal(result.tokenInvalid, true);
  assert.equal(result.ticketId, undefined);
});

test('Expo rate limiting does not invalidate a still-live token', async () => {
  const result = await adapter({ data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }] }).send();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MessageRateExceeded');
  assert.equal(result.tokenInvalid, false);
});

test('non-200 transport refusal is distinct from malformed accepted response', async () => {
  const result = await adapter(null, 503).send();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'http_503');
  assert.equal(result.ticketId, undefined);
});
