import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const db = await PGlite.create();
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
try {
  // Only external schema/identity seams are fixtures. Reservation,
  // locks, constraints, grants and SQL below are the actual candidate migration.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role', true) $$;
    create table public.profiles (id uuid primary key references auth.users, account_status text);
    insert into auth.users values ('${a}'), ('${b}');
    insert into profiles values ('${a}', 'active'), ('${b}', 'active');
    select set_config('request.jwt.claim.role','service_role',false);
  `);
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261011222213_build35_speech_operational_cost_controls.sql'), 'utf8'));
  const reserve = async (actor = a, chars = 100, fingerprint = 'a'.repeat(64)) =>
    (await db.query('select public.reserve_speech_request($1,$2,$3) as result', [actor, fingerprint, chars])).rows[0].result;
  check((await reserve()).reason, 'disabled');
  check((await db.query('select count(*)::int as n from speech_request_reservations')).rows[0].n, 0);
  await db.exec('update speech_provider_control set enabled=true');
  check((await reserve()).reason, 'disabled');
  await db.exec('update speech_provider_control set daily_character_limit=200');
  await db.exec(`update profiles set account_status=null where id='${a}'`);
  check((await reserve()).reason, 'account_unavailable');
  await db.exec(`update profiles set account_status='active' where id='${a}'`);
  const first = await reserve(); check(first.allowed, true);
  check((await reserve(a, 1, 'b'.repeat(64))).reason, 'concurrent_request');
  check((await db.query('select public.finish_speech_request($1,$2,false) as result', [b, first.reservationId])).rows[0].result, false);
  check((await db.query('select public.finish_speech_request($1,$2,false) as result', [a, first.reservationId])).rows[0].result, true);
  // A provider-failed attempt stays charged, so a second actor cannot exceed
  // the global budget by causing failures or letting leases expire.
  check((await reserve(b, 101)).reason, 'character_budget');
  check((await reserve(b, 100)).allowed, true);
  check((await reserve(a, 1)).reason, 'character_budget');
  // Personal ledger rows are deleted for privacy; the actor-free total remains
  // charged so account deletion cannot reopen the provider's fleet budget.
  await db.exec(`delete from public.profiles where id='${b}'; delete from auth.users where id='${b}'`);
  check((await db.query('select count(*)::int as n from speech_request_reservations where user_id=$1', [b])).rows[0].n, 0);
  check((await db.query('select characters_consumed::int as n from speech_daily_cost')).rows[0].n, 200);
  check((await reserve(a, 1)).reason, 'character_budget');
  await db.exec('update speech_provider_control set enabled=false');
  check((await reserve()).reason, 'disabled');
  for (const role of ['anon', 'authenticated']) {
    const grants = (await db.query(`select has_function_privilege($1,'public.reserve_speech_request(uuid,text,integer)','execute') as reserve,
      has_function_privilege($1,'public.finish_speech_request(uuid,uuid,boolean)','execute') as finish,
      has_table_privilege($1,'public.speech_provider_control','update') as control`, [role])).rows[0];
    check(grants, { reserve: false, finish: false, control: false });
  }
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  await assert.rejects(reserve(), /Service role required/); checks++;
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  await assert.rejects(reserve(a, 1001), /Invalid speech reservation/); checks++;
  await assert.rejects(reserve(a, 1, 'plaintext'), /Invalid speech reservation/); checks++;
  check((await db.query("select count(*)::int as n from pg_class where relname in ('speech_provider_control','speech_request_reservations','speech_daily_cost') and relrowsecurity")).rows[0].n, 3);
  console.log(JSON.stringify({ result: 'PASS', checks, runtime: 'PGlite 0.5.8',
    scope: 'actual candidate SQL; external Auth/profile fixtures; not live multi-session concurrency certification' }));
} finally { await db.close(); }
