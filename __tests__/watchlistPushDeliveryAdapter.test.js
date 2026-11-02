// Build 35 / Agent 3: execute the actual Expo Watchlist push adapter.
// A malformed/missing ticket is a separate source finding, not a passing test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const file = path.resolve(__dirname, '..', 'supabase', 'functions', 'commerce-watch-refresh', 'pushDelivery.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const ID = '11111111-1111-4111-8111-111111111111';
const event = (overrides = {}) => ({
  watchId: ID, eventType: 'target_price_reached',
  displayTitle: 'Saved black tee', priceText: 'USD 19.00', ...overrides,
});

function load(fetchImpl, env = {}) {
  const ctx = { exports: {}, fetch: fetchImpl, Deno: { env: { get: name => env[name] } } };
  vm.runInNewContext(compiled, ctx, { filename: file, timeout: 5000 });
  return ctx.exports;
}
const http = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('accepted ticket returns id and a bounded first-party Watchlist payload', async () => {
  const calls = [];
  const mod = load(async (url, init) => {
    calls.push({ url, init });
    return http(200, { data: [{ status: 'ok', id: 'ticket-1' }] });
  });
  const result = await mod.sendWatchPush('ExpoPushToken[synthetic-one]', event());
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.ticketId, 'ticket-1');
  assert.equal(result.tokenInvalid, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://exp.host/--/api/v2/push/send');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['body', 'channelId', 'data', 'sound', 'title', 'to'].sort());
  assert.equal(sent[0].to, 'ExpoPushToken[synthetic-one]');
  assert.equal(sent[0].channelId, 'price-alerts');
  assert.equal(sent[0].sound, 'default');
  assert.equal(sent[0].title, 'Your target price was reached');
  assert.equal(sent[0].body, 'Saved black tee is now USD 19.00');
  assert.deepEqual(sent[0].data, {
    watchId: ID, eventType: 'target_price_reached',
    deepLink: 'kscan://watchlist/' + ID,
  });
});

test('long saved display names are clamped and do not add vendor fields', async () => {
  let sent;
  const mod = load(async (_, init) => {
    sent = JSON.parse(init.body)[0];
    return http(200, { data: [{ status: 'ok', id: 'ticket-2' }] });
  }, { EXPO_PUSH_ACCESS_TOKEN: ' fake-synthetic-secret ' });
  const result = await mod.sendWatchPush('ExpoPushToken[synthetic-two]', event({
    eventType: 'price_decreased', displayTitle: 'A'.repeat(800), priceText: 'USD 12.00',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.ticketId, 'ticket-2');
  assert.ok(sent.body.length <= 160);
  assert.ok(sent.body.startsWith('A'.repeat(59) + '…'));
  assert.equal(sent.title, 'Price dropped');
  assert.equal(sent.data.eventType, 'price_decreased');
  assert.deepEqual(Object.keys(sent.data).sort(), ['deepLink', 'eventType', 'watchId'].sort());
});

test('no token is rejected before any HTTP request', async () => {
  let fetches = 0;
  const mod = load(async () => { fetches++; throw new Error('must not fetch'); });
  const result = await mod.sendWatchPush('', event());
  assert.equal(result.attempted, false);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'no_token');
  assert.equal(fetches, 0);
});

test('HTTP 503 rejects without attempting JSON parsing', async () => {
  let parsed = false;
  const mod = load(async () => ({ ok: false, status: 503, json: async () => { parsed = true; } }));
  const result = await mod.sendWatchPush('ExpoPushToken[synthetic]', event());
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'http_503');
  assert.equal(result.ticketId, undefined);
  assert.equal(parsed, false);
});

test('DeviceNotRegistered ticket rejects and retires only the reported token', async () => {
  const mod = load(async () => http(200, {
    data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
  }));
  const result = await mod.sendWatchPush('ExpoPushToken[dead-synthetic]', event());
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DeviceNotRegistered');
  assert.equal(result.tokenInvalid, true);
  assert.equal(result.ticketId, undefined);
});

test('MessageRateExceeded ticket rejects without invalid-token authority', async () => {
  const mod = load(async () => http(200, {
    data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }],
  }));
  const result = await mod.sendWatchPush('ExpoPushToken[rate-synthetic]', event());
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MessageRateExceeded');
  assert.equal(result.tokenInvalid, false);
  assert.equal(result.ticketId, undefined);
});

test('network failure is a bounded error and never logs provider details', async () => {
  const mod = load(async () => { throw new Error('synthetic sensitive transport failure'); });
  const result = await mod.sendWatchPush('ExpoPushToken[synthetic]', event());
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'network_error');
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});

test('DeveloperError ticket rejects without invalidating the token', async () => {
  const mod = load(async () => http(200, {
    data: [{ status: 'error', details: { error: 'DeveloperError' } }],
  }));
  const result = await mod.sendWatchPush('ExpoPushToken[synthetic]', event({
    eventType: 'listing_unavailable', priceText: null,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DeveloperError');
  assert.equal(result.tokenInvalid, false);
});
