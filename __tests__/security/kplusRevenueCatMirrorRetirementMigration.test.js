#!/usr/bin/env node
'use strict';

/**
 * Structural regression tests for the forward-only migration that retires the
 * RevenueCat promotional mirror when local complimentary K+ is revoked
 * (REVENUECAT_REVOCATION_RETIREMENT).
 *
 * These assert on the migration's SQL text -- there is no live Postgres in
 * this run. The file is located by name suffix because its version prefix is
 * whatever the staging ledger minted when it was applied.
 *
 * What is being protected:
 *   1. The promotional mirror contract is promotional-ONLY. Mirroring on
 *      overall K+ access would assert a store subscription, or a legacy row of
 *      unverified provenance, to RevenueCat as a promotional grant.
 *   2. A surviving complimentary grant keeps the mirror. Retirement is for the
 *      case where NO promotional state remains, never "one grant was revoked".
 *   3. Local revocation stays non-blocking. The database side of this repair
 *      is one queue upsert inside the revoking transaction -- no external call,
 *      no wait, nothing that a RevenueCat outage could roll back.
 *   4. The queue is service-role-only current state, not a client-reachable
 *      table and not an unbounded event log holding provider payloads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const MIGRATION_PATTERN = /^(\d{14})_kplus_revenuecat_mirror_retirement\.sql$/;

const SEARCH_PATH_PATTERN = /^(\d{14})_kplus_promotional_mirror_sources_search_path\.sql$/;

const matches = fs.readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_PATTERN.test(f));
const migrationFile = matches[0];
const SQL = migrationFile ? fs.readFileSync(path.join(MIGRATIONS_DIR, migrationFile), 'utf8') : '';

// The follow-up migration that pins search_path on kplus_promotional_mirror_sources
// (Supabase advisor 0011). It is a separate forward migration because the one
// above was already recorded in the staging ledger and must not be edited.
const searchPathMatches = fs.readdirSync(MIGRATIONS_DIR).filter((f) => SEARCH_PATH_PATTERN.test(f));
const searchPathFile = searchPathMatches[0];
const SEARCH_PATH_SQL = searchPathFile
  ? fs.readFileSync(path.join(MIGRATIONS_DIR, searchPathFile), 'utf8')
  : '';

function stripComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const CODE = stripComments(SQL);

/**
 * The text of one `create ... function/table` statement. A function body ends
 * at its `$$;` terminator, not at the first semicolon inside it.
 */
function statement(startNeedle) {
  const start = CODE.indexOf(startNeedle);
  assert.ok(start >= 0, `statement not found: ${startNeedle}`);
  const dollarEnd = CODE.indexOf('\n$$;', start);
  const parenEnd = CODE.indexOf('\n);', start);
  const ends = [
    dollarEnd >= 0 ? dollarEnd + 4 : Infinity,
    parenEnd >= 0 ? parenEnd + 3 : Infinity,
  ];
  const end = Math.min(...ends);
  assert.ok(Number.isFinite(end), `unterminated statement: ${startNeedle}`);
  return CODE.slice(start, end);
}

/**
 * Executable SQL only: `comment on ... is '...'` literals are documentation,
 * and deliberately DO name the things this lane excludes.
 */
const EXECUTABLE = CODE.replace(/comment on [\s\S]*?';/g, '');

test('the migration exists exactly once and is a new forward-only file', () => {
  assert.equal(matches.length, 1, 'exactly one kplus_revenuecat_mirror_retirement migration');
  assert.ok(/^\d{14}_/.test(migrationFile), 'the filename carries a 14-digit ledger version');

  // Forward-only: it creates its own objects and never rewrites an applied one.
  assert.doesNotMatch(CODE, /\bdrop\s+table\b/i);
  assert.doesNotMatch(CODE, /\bdrop\s+function\b/i);
  assert.doesNotMatch(CODE, /\balter\s+table\s+public\.(user_entitlements|kplus_entitlement_grants)\b/i);
  assert.doesNotMatch(CODE, /\btruncate\b/i);
});

// ── 1. The promotional mirror contract ────────────────────────────────────

test('the promotional source list is the complimentary family only -- no store, no legacy-unverified', () => {
  const sources = statement('create or replace function public.kplus_promotional_mirror_sources()');
  const listed = [...sources.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  assert.deepEqual(listed, [
    'complimentary',
    'complimentary_code',
    'employee',
    'friends_family',
    'manual_support',
    'promotional',
  ]);

  // These two are the whole point of the restriction.
  assert.equal(listed.includes('store_subscription'), false,
    'Apple/Google billing is never a promotional mirror source');
  assert.equal(listed.includes('legacy_unverified'), false,
    'legacy rows of unverified provenance are never asserted as promotional');
});

test('kplus_promotional_mirror_state derives from kplus_entitlement_facts, gated on contributes_access and the source list', () => {
  const fn = statement('create or replace function public.kplus_promotional_mirror_state(');

  assert.match(fn, /public\.kplus_entitlement_facts\(/,
    'desired state is derived from the existing resolver, not re-derived from raw tables');
  assert.match(fn, /f\.contributes_access/,
    'only grants that actually confer access may be mirrored');
  assert.match(fn, /f\.source\s*=\s*any\s*\(\s*public\.kplus_promotional_mirror_sources\(\)\s*\)/,
    'the source restriction must come from the single shared list');

  // It must not fall back to the user-level predicate, which includes store
  // subscriptions and legacy-unverified rows.
  assert.doesNotMatch(fn, /kplus_has_active_entitlement/);
  assert.doesNotMatch(fn, /kplus_effective_access_state/);
  assert.doesNotMatch(fn, /kplus_user_entitlement_row_is_active/);

  // Read-only.
  assert.match(fn, /\bstable\b/);
  assert.match(fn, /security definer/);
  assert.match(fn, /set search_path = public/);
  assert.doesNotMatch(fn, /\b(insert|update|delete)\b/i);
});

test('effective-expiry semantics match the project: open-ended wins, otherwise the latest surviving expiry', () => {
  const fn = statement('create or replace function public.kplus_promotional_mirror_state(');

  // Open-ended anywhere in the contributing promotional set -> NULL expiry.
  assert.match(fn, /bool_or\(e\.is_open_ended\)/);
  assert.match(fn, /then null/);
  // Otherwise the LATEST surviving window -- never the revoked one, and never
  // shortened to the earliest.
  assert.match(fn, /max\(e\.access_until\)/);
  assert.doesNotMatch(fn, /min\(e\.access_until\)/,
    'taking the earliest expiry would shorten a surviving grant');
});

// ── 2. Retirement only when nothing promotional remains ───────────────────

test('nothing in the migration decides retirement from a single grant -- the queue carries no expiry or action', () => {
  const table = statement('create table if not exists public.kplus_revenuecat_mirror_queue (');

  // The queue is "this pair is dirty", nothing more. If it carried an action
  // or an expiry, the worker could replay a stale decision.
  for (const forbidden of ['expires_at', 'action', 'desired', 'grant_id', 'revoke']) {
    assert.equal(table.includes(forbidden), false,
      `the queue must not carry "${forbidden}" -- desired state is resolved at execution time`);
  }
  assert.match(table, /primary key \(user_id, entitlement_key\)/,
    'at most one unit of work per user + entitlement');
});

// ── 3. Local revocation stays non-blocking ────────────────────────────────

test('the database side of the repair makes no external call and cannot block or roll back a revocation', () => {
  for (const forbidden of [
    'http', 'net.http', 'pg_net', 'extension', 'revenuecat.com', 'curl',
    'dblink', 'pg_background', 'notify',
  ]) {
    assert.equal(EXECUTABLE.toLowerCase().includes(forbidden), false,
      `the revoking transaction must never reach "${forbidden}"`);
  }
});

test('the triggers only ever enqueue -- they never write an entitlement, an expiry or an access decision', () => {
  for (const header of [
    'create or replace function public.kplus_user_entitlements_mirror_retire_tg()',
    'create or replace function public.kplus_grants_mirror_retire_tg()',
  ]) {
    const fn = statement(header);
    assert.match(fn, /perform public\.kplus_enqueue_revenuecat_mirror_retirement\(old\.user_id, old\.entitlement_key\)/,
      'the trigger enqueues OLD\'s pair and nothing else');
    assert.match(fn, /return null;/, 'AFTER trigger, result discarded');
    assert.doesNotMatch(fn, /\binsert\s+into\s+public\.(user_entitlements|kplus_entitlement_grants)\b/i);
    assert.doesNotMatch(fn, /\bupdate\s+public\.(user_entitlements|kplus_entitlement_grants)\b/i);
  }
});

test('revocation is not gated on the mirror: the migration adds no check to any existing revocation path', () => {
  // grant/revoke RPCs are untouched -- this migration must not redefine them.
  for (const untouched of [
    'revoke_kplus_grant', 'grant_kplus_complimentary', 'grant_kplus_early_access',
    'apply_kplus_provider_transition', 'kplus_has_active_entitlement',
    'kplus_user_entitlement_row_is_active', 'set_kplus_revenuecat_sync_status',
    'list_kplus_pending_revenuecat_sync',
  ]) {
    assert.doesNotMatch(
      CODE,
      new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${untouched}\\b`, 'i'),
      `${untouched} must not be redefined by the retirement migration`,
    );
  }
});

// ── Trigger shape: contraction only, complimentary family only ────────────

test('both triggers are AFTER UPDATE only -- never INSERT, never DELETE', () => {
  const triggers = [...CODE.matchAll(/create trigger\s+(\w+)\s+([\s\S]*?)\s+execute function/g)];
  assert.equal(triggers.length, 2, 'exactly two triggers are created');

  for (const [, name, bodyText] of triggers) {
    assert.match(bodyText, /after update on/, `${name} must be AFTER UPDATE`);
    assert.doesNotMatch(bodyText, /\binsert\b/i,
      `${name} must not fire on INSERT -- a new grant is not a retirement`);
    assert.doesNotMatch(bodyText, /\bdelete\b/i,
      `${name} must not fire on DELETE -- account deletion retires the mirror directly`);
    assert.match(bodyText, /for each row/, `${name} must be row-level`);
    assert.match(bodyText, /\bwhen\s*\(/, `${name} must carry an explicit WHEN clause`);
  }
});

test('the user_entitlements trigger fires only for complimentary-family rows that contracted', () => {
  const trig = CODE.slice(
    CODE.indexOf('create trigger user_entitlements_revenuecat_mirror_retire'),
    CODE.indexOf('execute function public.kplus_user_entitlements_mirror_retire_tg()'),
  );

  // Family restriction: the four Build 34 complimentary grant reasons, and
  // never trial / paid_ios / paid_android.
  assert.match(trig, /old\.grant_reason in \('complimentary_early_access', 'staff', 'admin', 'promo'\)/);
  for (const paid of ['trial', 'paid_ios', 'paid_android']) {
    assert.equal(trig.includes(`'${paid}'`), false, `${paid} is not a promotional mirror source`);
  }

  // Every way a legacy row goes inactive.
  assert.match(trig, /old\.status = 'active' and new\.status is distinct from 'active'/,
    'status active -> expired/revoked must enqueue');
  assert.match(trig, /old\.revoked_at is null and new\.revoked_at is not null/,
    'a revocation recorded as a timestamp alone must enqueue');
  assert.match(trig, /new\.expires_at is null or new\.expires_at < old\.expires_at/,
    'a shortened or cleared expiry must enqueue');
});

test('the grants trigger fires only for complimentary-family grants that contracted, never for store subscriptions', () => {
  const trig = CODE.slice(
    CODE.indexOf('create trigger kplus_entitlement_grants_revenuecat_mirror_retire'),
    CODE.indexOf('execute function public.kplus_grants_mirror_retire_tg()'),
  );

  assert.match(trig, /old\.source <> 'store_subscription'/,
    'a store subscription transition must never enqueue a promotional retirement');
  assert.match(trig, /old\.revoked_at is null and new\.revoked_at is not null/,
    'revoke_kplus_grant must enqueue');
  assert.match(trig, /old\.is_open_ended and not new\.is_open_ended/,
    'closing off an open-ended grant must enqueue');
  assert.match(trig, /new\.expires_at < old\.expires_at/,
    'a shortened expiry must enqueue');
});

test('a sync-status-only update never enqueues -- set_kplus_revenuecat_sync_status must not self-trigger', () => {
  const trig = CODE.slice(
    CODE.indexOf('create trigger user_entitlements_revenuecat_mirror_retire'),
    CODE.indexOf('execute function public.kplus_user_entitlements_mirror_retire_tg()'),
  );
  // The WHEN clause names only entitlement-shape columns. If it referenced
  // external_sync_status or updated_at, every mirror attempt would re-dirty
  // the pair it just converged -- an infinite reconciliation loop.
  assert.equal(trig.includes('external_sync_status'), false);
  assert.equal(trig.includes('updated_at'), false);
  assert.equal(trig.includes('external_customer_id'), false);
});

// ── 4. Queue privileges and shape ─────────────────────────────────────────

test('the queue table is service-role read-only, RLS-enabled, and carries no client policy', () => {
  assert.match(CODE, /alter table public\.kplus_revenuecat_mirror_queue enable row level security/);
  assert.match(
    CODE,
    /revoke all on public\.kplus_revenuecat_mirror_queue\s*\n?\s*from public, anon, authenticated, service_role;/,
  );
  assert.match(CODE, /grant select on public\.kplus_revenuecat_mirror_queue to service_role;/);

  // No policy at all, and no write grant to anyone.
  assert.doesNotMatch(CODE, /create policy[\s\S]*kplus_revenuecat_mirror_queue/i);
  assert.doesNotMatch(CODE, /grant (insert|update|delete|all)[^;]*kplus_revenuecat_mirror_queue/i);
});

test('the queue persists no RevenueCat payload, receipt, token, email or other PII beyond the existing UUID authority', () => {
  const table = statement('create table if not exists public.kplus_revenuecat_mirror_queue (');
  for (const forbidden of [
    'payload', 'response', 'body', 'receipt', 'token', 'email', 'purchase',
    'transaction', 'customer_id', 'secret', 'jwt',
  ]) {
    assert.equal(table.toLowerCase().includes(forbidden), false,
      `the queue must never persist "${forbidden}"`);
  }

  // The one free-text column is constrained to a bare outcome word.
  assert.match(table, /last_reason is null or last_reason ~ '\^\[A-Za-z0-9_\.:\]\{1,64\}\$'/,
    'last_reason is constrained so a response body cannot be smuggled into it');
});

test('the worker surface is bounded, idempotent and distinguishes pending / synced / failed', () => {
  const table = statement('create table if not exists public.kplus_revenuecat_mirror_queue (');
  assert.match(table, /'pending', 'synced', 'not_required',\s*\n?\s*'failed_retryable', 'failed_terminal'/);

  const list = statement('create or replace function public.list_kplus_revenuecat_mirror_retirements(');
  assert.match(list, /status in \('pending', 'failed_retryable'\)/,
    'settled and terminal rows must not be re-listed');
  assert.match(list, /limit greatest\(1, least\(coalesce\(p_limit, 25\), 200\)\)/,
    'the same bounded batch shape as list_kplus_pending_revenuecat_sync');
  assert.match(list, /order by q\.enqueued_at asc/, 'oldest first');
  assert.match(list, /\bstable\b/);
});

test('a permanently failing pair dead-letters instead of becoming a retry storm', () => {
  const settle = statement('create or replace function public.set_kplus_revenuecat_mirror_status(');
  assert.match(settle, /c_max_attempts constant integer := 10/);
  assert.match(
    settle,
    /when p_status = 'failed_retryable' and v_attempts >= c_max_attempts\s*\n?\s*then 'failed_terminal'/,
    'an exhausted pair leaves the batch rather than starving live work',
  );
  // It settles mirror bookkeeping only.
  assert.doesNotMatch(settle, /public\.(user_entitlements|kplus_entitlement_grants)/);
});

test('every new function is revoked from public/anon/authenticated, and only the worker surface is granted to service_role', () => {
  const clientReachable = [
    'kplus_promotional_mirror_sources()',
    'kplus_promotional_mirror_state(uuid, text, timestamptz)',
    'list_kplus_revenuecat_mirror_retirements(integer)',
    'set_kplus_revenuecat_mirror_status(uuid, text, text, text)',
  ];
  for (const sig of clientReachable) {
    const escaped = sig.replace(/[()]/g, '\\$&').replace(/,\s*/g, ',\\s*');
    assert.match(
      CODE,
      new RegExp(`revoke all on function public\\.${escaped}\\s*\\n?\\s*from public, anon, authenticated`),
      `${sig} must be revoked from every client role`,
    );
    assert.match(
      CODE,
      new RegExp(`grant execute on function public\\.${escaped}\\s*\\n?\\s*to service_role`),
      `${sig} is a service-role primitive`,
    );
  }

  // The enqueue helper and both trigger functions are revoked from EVERY role
  // including service_role: only the triggers may call them.
  for (const sig of [
    'kplus_enqueue_revenuecat_mirror_retirement(uuid, text)',
    'kplus_user_entitlements_mirror_retire_tg()',
    'kplus_grants_mirror_retire_tg()',
  ]) {
    const escaped = sig.replace(/[()]/g, '\\$&').replace(/,\s*/g, ',\\s*');
    assert.match(
      CODE,
      new RegExp(`revoke all on function public\\.${escaped}\\s*\\n?\\s*from public, anon, authenticated, service_role`),
      `${sig} must not be directly callable by anyone`,
    );
    assert.doesNotMatch(
      CODE,
      new RegExp(`grant execute on function public\\.${escaped}`),
      `${sig} must have no execute grant at all`,
    );
  }
});

test('every new function pins search_path -- SECURITY DEFINER or not (Supabase advisor 0011)', () => {
  // The follow-up migration supersedes the helper's definition, so check the
  // pair the way Postgres sees them: last definition wins.
  const combined = CODE + '\n' + stripComments(SEARCH_PATH_SQL);
  const defs = [...combined.matchAll(/create or replace function public\.(\w+)\(([\s\S]*?)\n\$\$;/g)];
  assert.ok(defs.length >= 7, 'all new functions are accounted for');

  const finalBodyByName = new Map();
  for (const [body, name] of defs) finalBodyByName.set(name, body);

  for (const [name, body] of finalBodyByName) {
    assert.match(body, /set search_path = public/,
      `${name} must pin search_path -- a mutable search_path is advisor 0011`);
  }
});

test('the search_path follow-up is forward-only and changes nothing but the resolution pin', () => {
  assert.equal(searchPathMatches.length, 1, 'exactly one search_path follow-up migration');
  const code = stripComments(SEARCH_PATH_SQL);

  // It must not edit the already-applied migration's other objects.
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /create trigger/i);
  assert.doesNotMatch(code, /drop /i);
  assert.doesNotMatch(code, /alter table/i);
  assert.doesNotMatch(code, /kplus_revenuecat_mirror_queue/);

  // Only the one helper is redefined, with its source list and privileges intact.
  const defs = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(defs, ['kplus_promotional_mirror_sources']);
  assert.match(code, /set search_path = public/);
  assert.match(code, /\bimmutable\b/, 'volatility is preserved');

  const listed = [...code.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, [
    'complimentary', 'complimentary_code', 'employee',
    'friends_family', 'manual_support', 'promotional',
  ], 'the promotional source list is unchanged by the pin');

  assert.match(code, /revoke all on function public\.kplus_promotional_mirror_sources\(\)\s*\n?\s*from public, anon, authenticated/);
  assert.match(code, /grant execute on function public\.kplus_promotional_mirror_sources\(\)\s*\n?\s*to service_role/);

  // The pinned version sorts after the migration it follows.
  assert.ok(searchPathFile > migrationFile, 'the follow-up applies after the migration it amends');
});

test('no Apple or Google billing concept appears in the migration\'s executable SQL', () => {
  for (const forbidden of ['apple', 'google', 'refund', 'cancel_subscription', 'app_store', 'play_billing']) {
    assert.equal(EXECUTABLE.toLowerCase().includes(forbidden), false,
      `the promotional retirement lane must never reference "${forbidden}"`);
  }
  // The documentation comments may name them -- that is how the exclusion is
  // recorded for the next reader -- but only ever as an exclusion.
  assert.match(CODE, /Excludes store_subscription \(Apple\/Google billing\)/);
});

// ── MUTATION tests: each unsafe change must fail a targeted assertion ──────

function mutate(from, to) {
  assert.ok(CODE.includes(from), `mutation source not found: ${from}`);
  return CODE.replace(from, to);
}

test('MUTATION: adding store_subscription to the promotional source list fails the source contract', () => {
  const mutated = mutate("'friends_family', 'manual_support', 'promotional'",
    "'friends_family', 'manual_support', 'promotional', 'store_subscription'");
  const start = mutated.indexOf('create or replace function public.kplus_promotional_mirror_sources()');
  const listed = [...mutated.slice(start, mutated.indexOf('$$;', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  assert.throws(
    () => assert.equal(listed.includes('store_subscription'), false),
    /store_subscription|true !== false/,
    'a store source in the promotional list must fail the isolation assertion',
  );
});

test('MUTATION: using overall K+ access instead of promotional-only state fails the contract assertion', () => {
  const mutated = mutate(
    'f.source = any (public.kplus_promotional_mirror_sources())',
    'public.kplus_has_active_entitlement(p_user_id, p_entitlement_key)',
  );
  const fn = mutated.slice(
    mutated.indexOf('create or replace function public.kplus_promotional_mirror_state('),
  );
  assert.throws(
    () => assert.doesNotMatch(fn.slice(0, fn.indexOf('$$;')), /kplus_has_active_entitlement/),
    /kplus_has_active_entitlement/,
    'the user-level predicate must never answer the promotional question',
  );
});

test('MUTATION: taking the earliest surviving expiry (shortening a survivor) fails the expiry assertion', () => {
  const mutated = mutate('max(e.access_until)', 'min(e.access_until)');
  const fn = mutated.slice(
    mutated.indexOf('create or replace function public.kplus_promotional_mirror_state('),
  );
  assert.throws(
    () => assert.match(fn.slice(0, fn.indexOf('$$;')), /max\(e\.access_until\)/),
    /max/,
    'a surviving grant must never be shortened',
  );
});

test('MUTATION: firing the grants trigger on INSERT fails the trigger-shape assertion', () => {
  const mutated = mutate(
    'after update on public.kplus_entitlement_grants',
    'after insert or update on public.kplus_entitlement_grants',
  );
  const triggers = [...mutated.matchAll(/create trigger\s+(\w+)\s+([\s\S]*?)\s+execute function/g)];
  const grantsTrigger = triggers.find(([, name]) => name === 'kplus_entitlement_grants_revenuecat_mirror_retire');
  assert.throws(
    () => assert.doesNotMatch(grantsTrigger[2], /\binsert\b/i),
    /insert/i,
    'firing on INSERT would mirror grants Build 34 never mirrored',
  );
});

test('MUTATION: letting the grants trigger fire for store subscriptions fails the isolation assertion', () => {
  const mutated = mutate("old.source <> 'store_subscription'", 'true');
  const trig = mutated.slice(
    mutated.indexOf('create trigger kplus_entitlement_grants_revenuecat_mirror_retire'),
    mutated.indexOf('execute function public.kplus_grants_mirror_retire_tg()'),
  );
  assert.throws(
    () => assert.match(trig, /old\.source <> 'store_subscription'/),
    /store_subscription/,
    'a store transition must never enqueue a promotional retirement',
  );
});

test('MUTATION: granting execute on the retirement primitives to authenticated fails the privilege assertion', () => {
  const mutated = mutate(
    'grant execute on function public.set_kplus_revenuecat_mirror_status(uuid, text, text, text)\n  to service_role;',
    'grant execute on function public.set_kplus_revenuecat_mirror_status(uuid, text, text, text)\n  to service_role, authenticated;',
  );
  assert.throws(
    () => {
      assert.doesNotMatch(
        mutated,
        /grant execute on function public\.set_kplus_revenuecat_mirror_status\([^)]*\)\s*\n?\s*to [^;]*authenticated/,
      );
    },
    /authenticated/,
    'no client role may drive retirement bookkeeping for arbitrary UUIDs',
  );
});

test('MUTATION: dropping the contributes_access gate fails the desired-state assertion', () => {
  const mutated = mutate('where f.contributes_access\n', 'where true\n');
  const fn = mutated.slice(
    mutated.indexOf('create or replace function public.kplus_promotional_mirror_state('),
  );
  assert.throws(
    () => assert.match(fn.slice(0, fn.indexOf('$$;')), /f\.contributes_access/),
    /contributes_access/,
    'a revoked or expired grant must never keep the mirror alive',
  );
});

test('MUTATION: removing the attempt cap fails the retry-storm assertion', () => {
  const mutated = mutate(
    "when p_status = 'failed_retryable' and v_attempts >= c_max_attempts",
    "when false",
  );
  const start = mutated.indexOf('create or replace function public.set_kplus_revenuecat_mirror_status(');
  const settle = mutated.slice(start, mutated.indexOf('$$;', start));
  assert.throws(
    () => assert.match(settle, /when p_status = 'failed_retryable' and v_attempts >= c_max_attempts/),
    /c_max_attempts/,
    'without the cap an unconvergeable pair retries forever',
  );
});
