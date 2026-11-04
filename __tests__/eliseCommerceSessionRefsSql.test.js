// Executes the real OC-01 reference-store migration in PGlite. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261104193023_elise_commerce_session_refs.sql'),
  'utf8',
);
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONV_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccc01';
const CONV_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccc02';

async function database() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.style_chat_sessions(id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade);
    -- Mirror Supabase defaults: service_role bypasses RLS and can read existing public tables.
    alter role service_role bypassrls; grant select on public.style_chat_sessions to service_role;
    insert into auth.users values('${A}'),('${B}');
    insert into public.style_chat_sessions values('${CONV_A}','${A}'),('${CONV_B}','${B}');`);
  await db.exec(migration);
  await db.exec('set role service_role');
  return db;
}

let n = 0;
function record(lifetimeMs = 30_000, extra = {}) {
  n += 1;
  const ref = `p_${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const now = Date.now();
  return {
    ref,
    position: ((n - 1) % 8) + 1,
    expiresAtMs: now + lifetimeMs,
    record: { ref, title: `Synthetic jacket ${n}`, merchant: 'Synthetic Shop', productUrl: `https://shop.fixture-fashion.com/${n}`, provenance: { provider: 'serper', sourceId: `s${n}`, observedAt: now, expiresAt: now + lifetimeMs, trust: 'provider_record' } },
    ...extra,
  };
}
const store = (db, actor, conv, records) => db.query('select public.elise_commerce_refs_store($1,$2,$3::jsonb) as n', [actor, conv, JSON.stringify(records)]);
const load = async (db, actor, conv) => (await db.query('select * from public.elise_commerce_refs_load($1,$2)', [actor, conv])).rows;

test('owner round-trip; another actor or another conversation reads nothing', async () => {
  const db = await database();
  await store(db, A, CONV_A, [record(), record()]);
  assert.equal((await load(db, A, CONV_A)).length, 2);
  assert.equal((await load(db, B, CONV_A)).length, 0, 'cross-account read returns nothing');
  assert.equal((await load(db, A, CONV_B)).length, 0, 'foreign conversation returns nothing');
  await assert.rejects(store(db, B, CONV_A, [record()]), /conversation not owned by actor/);
});

test('lifetime is capped at 30 seconds whatever the caller requests; expired rows are invisible and cleaned', async () => {
  const db = await database();
  await store(db, A, CONV_A, [record(3_600_000)]);
  const [row] = await load(db, A, CONV_A);
  const lifetime = new Date(row.expires_at) - new Date(row.created_at);
  assert.ok(lifetime <= 30_000, `lifetime ${lifetime}`);
  // A row whose requested expiry is already past is not stored at all.
  await store(db, A, CONV_A, [record(-1)]);
  assert.equal((await load(db, A, CONV_A)).length, 1);
  // Expire it and confirm load hides and removes it.
  await db.exec("reset role; update public.elise_commerce_session_refs set created_at = now() - interval '40 seconds', expires_at = now() - interval '10 seconds'; set role service_role");
  assert.equal((await load(db, A, CONV_A)).length, 0);
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int as c from public.elise_commerce_session_refs')).rows[0].c, 0);
});

test('bounded: at most 16 records per write and the newest 32 per conversation', async () => {
  const db = await database();
  await assert.rejects(store(db, A, CONV_A, Array.from({ length: 17 }, () => record())), /record limit exceeded/);
  for (let i = 0; i < 5; i++) await store(db, A, CONV_A, Array.from({ length: 8 }, () => record()));
  assert.equal((await load(db, A, CONV_A)).length, 32);
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int as c from public.elise_commerce_session_refs')).rows[0].c, 32);
});

test('records are size-bounded and refs are opaque broker refs', async () => {
  const db = await database();
  await assert.rejects(store(db, A, CONV_A, [record(30_000, { ref: 'p_not-a-ref' })]));
  const big = record();
  big.record.title = 'x'.repeat(5000);
  await assert.rejects(store(db, A, CONV_A, [big]));
});

test('anon and authenticated can neither read the table nor execute either RPC', async () => {
  const db = await database();
  await store(db, A, CONV_A, [record()]);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role}`);
    await assert.rejects(db.query('select * from public.elise_commerce_session_refs'), /permission denied/, role);
    await assert.rejects(db.query('select * from public.elise_commerce_refs_load($1,$2)', [A, CONV_A]), /permission denied/, role);
    await assert.rejects(store(db, A, CONV_A, [record()]), /permission denied/, role);
  }
});

test('deleting the conversation or the account removes its references', async () => {
  const db = await database();
  await store(db, A, CONV_A, [record()]);
  await store(db, B, CONV_B, [record()]);
  await db.exec(`reset role; delete from public.style_chat_sessions where id = '${CONV_A}'; delete from auth.users where id = '${B}'`);
  assert.equal((await db.query('select count(*)::int as c from public.elise_commerce_session_refs')).rows[0].c, 0);
});
