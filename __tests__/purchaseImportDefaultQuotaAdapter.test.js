// Actual default handler/adapter and migration SQL. Identity, consent, SDK
// transport and the provider are controlled; no live API or paid request.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./helpers/purchaseImportQuotaWorld');
const OPAQUE_ID = 'session0001'; // Accepted existing handler/client wire contract.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('accepted opaque client ID reaches default quota adapter, actual SQL and sanitized success', async () => {
  const w = await world();
  try {
    const res = await w.extract(OPAQUE_ID);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(w.providerCalls.length, 1);
    assert.equal((await w.db.query("select count(*)::int n from provider_request_reservations where status='completed'")).rows[0].n, 1);
    assert.match(w.rpcCalls[0].p.p_request_id, UUID);
    assert.notEqual(w.rpcCalls[0].p.p_request_id, OPAQUE_ID);
  } finally { await w.close(); }
});

test('existing UUID-shaped clients retain a successful source extraction', async () => {
  const w = await world();
  try {
    const res = await w.extract('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(w.providerCalls.length, 1);
  } finally { await w.close(); }
});

test('bookkeeping UUIDs remain separate from the stable session fingerprint and one reservation', async () => {
  const w = await world();
  try {
    const deps = w.handler.defaultPurchaseImportDeps;
    await deps.reserve('synthetic', OPAQUE_ID, '11111111-1111-4111-8111-111111111111');
    await deps.reserve('synthetic', OPAQUE_ID, '11111111-1111-4111-8111-111111111111');
    const [a, b] = w.rpcCalls;
    assert.match(a.p.p_request_id, UUID);
    assert.match(b.p.p_request_id, UUID);
    assert.notEqual(a.p.p_request_id, b.p.p_request_id);
    assert.equal(a.p.p_request_fingerprint, b.p.p_request_fingerprint);
    assert.equal((await w.db.query('select count(*)::int n from provider_request_reservations')).rows[0].n, 1);
    assert.equal(w.providerCalls.length, 0);
  } finally { await w.close(); }
});

test('negative control: opaque IDs directly forwarded to the UUID RPC are rejected by PostgreSQL', async () => {
  const w = await world();
  try {
    await assert.rejects(w.db.query('select * from reserve_provider_request($1,$2,$3::uuid,$4,$5)',
      ['purchase-import-extract', 'vision_ai', OPAQUE_ID, 'synthetic-fingerprint', 2]), err => err.code === '22P02');
    assert.equal(w.providerCalls.length, 0);
  } finally { await w.close(); }
});
