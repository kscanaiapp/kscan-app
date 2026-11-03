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
  ['missing ticket status', { data: [{ id: 'ticket-1' }] }],
  ['nonstring ticket id', { data: [{ status: 'ok', id: 123 }] }],
  ['object ticket id', { data: [{ status: 'ok', id: { value: 'ticket-1' } }] }],
  ['primitive ticket', { data: [false] }],
  ['primitive data', { data: 123 }],
  ['201-character id beyond receipt storage', { data: [{ status: 'ok', id: 'x'.repeat(201) }] }],
  ['256-character id beyond receipt storage', { data: [{ status: 'ok', id: 'x'.repeat(256) }] }],
  ['257-character id beyond receipt storage', { data: [{ status: 'ok', id: 'x'.repeat(257) }] }],
  ['NUL id not representable in PostgreSQL text', { data: [{ status: 'ok', id: 'ticket\0id' }] }],
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

for (const id of ['x'.repeat(200), '\u{1F45F}'.repeat(200)]) {
  test('receipt limit counts characters rather than UTF-16 units: ' + id.length + ' units', async () => {
    const result = await adapter({ data: [{ status: 'ok', id: ' ' + id + ' ' }] }).send();
    assert.equal(result.ok, true);
    assert.equal(result.ticketId, id);
  });
}

test('actual receipt migration enforces 1..200 characters and rejects NUL text', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const migration = fs.readFileSync(path.resolve(__dirname, '..', 'supabase/migrations/20260909115726_watchlist_push_receipts.sql'), 'utf8');
  const table = migration.match(/create table if not exists public\.watchlist_push_receipts\s*\([\s\S]*?\n\);/i)?.[0];
  assert.ok(table, 'execute the real table definition, including its actual CHECK');
  const db = new PGlite();
  try {
    await db.exec('create schema auth; create table auth.users(id uuid primary key); create table public.user_device_push_tokens(id uuid primary key);');
    await db.exec(table);
    await db.exec("insert into auth.users values ('11111111-1111-4111-8111-111111111111'); insert into public.user_device_push_tokens values ('22222222-2222-4222-8222-222222222222');");
    const insert = id => db.query('insert into public.watchlist_push_receipts(ticket_id,token_row_id,token_fingerprint,user_id) values($1,$2,$3,$4) returning ticket_id', [id, '22222222-2222-4222-8222-222222222222', '0'.repeat(64), '11111111-1111-4111-8111-111111111111']);
    for (const id of ['x', 'x'.repeat(200), '\u{1F45F}'.repeat(200)]) assert.equal((await insert(id)).rows[0].ticket_id, id);
    for (const id of ['', 'x'.repeat(201), 'x'.repeat(256), 'x'.repeat(257)]) await assert.rejects(insert(id), e => e.code === '23514' && e.message.includes('watchlist_push_receipts_ticket_id_len'));
    await assert.rejects(insert('ticket\0id'), e => /0x00|Unicode|UTF8|zero byte/i.test(e.message));
  } finally { await db.close(); }
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
