// Build 35: actual Expo push adapter must never claim acceptance without a
// ticket id usable by receiptProcessing.ts. No vendor calls or customer data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '..', 'supabase/functions/commerce-watch-refresh/pushDelivery.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const event = {
  watchId: '11111111-1111-4111-8111-111111111111',
  eventType: 'price_decreased',
  displayTitle: 'Synthetic watch',
  priceText: 'USD 10.00',
};

function adapter(payload) {
  const requests = [];
  const sandbox = {
    exports: {},
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, json: async () => payload };
    },
    Deno: { env: { get: () => undefined } },
  };
  vm.runInNewContext(compiled, sandbox, { filename: file, timeout: 5000 });
  return {
    requests,
    send: () => sandbox.exports.sendWatchPush('ExpoPushToken[synthetic]', event),
  };
}

for (const [name, payload] of [
  ['null JSON', null],
  ['empty data', { data: [] }],
  ['missing id', { data: [{ status: 'ok' }] }],
  ['whitespace id', { data: [{ status: 'ok', id: '   ' }] }],
  ['oversize id', { data: [{ status: 'ok', id: 'x'.repeat(257) }] }],
  ['missing status', { data: [{ id: 'ticket-one' }] }],
  ['wrong status', { data: [{ status: 'pending', id: 'ticket-one' }] }],
  ['nonstring id', { data: [{ status: 'ok', id: 123 }] }],
]) {
  test('Expo HTTP 200 with ' + name + ' is NOT a successful ticket', async () => {
    const w = adapter(payload);
    const result = await w.send();
    assert.equal(w.requests.length, 1);
    assert.equal(result.attempted, true);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'invalid_ticket');
    assert.equal(result.ticketId, undefined);
    assert.notEqual(result.tokenInvalid, true);
  });
}

test('a real accepted ticket is normalized and can be recorded by receipt processing', async () => {
  const w = adapter({ data: [{ status: 'ok', id: '  ticket-1  ' }] });
  const result = await w.send();
  assert.deepEqual(
    { attempted: result.attempted, ok: result.ok, ticketId: result.ticketId },
    { attempted: true, ok: true, ticketId: 'ticket-1' },
  );
});

test('explicit Expo terminal error never becomes accepted or an invalid-ticket success', async () => {
  const w = adapter({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] });
  const result = await w.send();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DeviceNotRegistered');
  assert.equal(result.tokenInvalid, true);
});
