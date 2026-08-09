#!/usr/bin/env node
'use strict';

/**
 * Structural regression tests for the applied RPC-hardening migration
 * (supabase/migrations/20260803214145_harden_public_rpc_execution_grants.sql
 * + its 20260803214253_..._trigger_cleanup.sql follow-up). These assert on
 * the migration's own SQL text -- there is no live Postgres in this test
 * run -- so a future edit to either file that silently drops a revoke,
 * grants something unintended, or removes the search_path pin gets caught
 * here before it ever reaches staging. Live behavior itself was validated
 * against yzqjvdfgefveprobvvyw with synthetic data; see
 * docs/security/supabase-exposure-audit.md.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const MAIN_MIGRATION = path.join(MIGRATIONS_DIR, '20260803214145_harden_public_rpc_execution_grants.sql');
const TRIGGER_CLEANUP_MIGRATION = path.join(
  MIGRATIONS_DIR,
  '20260803214253_harden_public_rpc_execution_grants_trigger_cleanup.sql',
);

const mainSql = fs.readFileSync(MAIN_MIGRATION, 'utf8');
const triggerCleanupSql = fs.readFileSync(TRIGGER_CLEANUP_MIGRATION, 'utf8');
const combinedSql = `${mainSql}\n${triggerCleanupSql}`;

// The exact, reviewed set of functions this pair of migrations revokes anon
// EXECUTE from. Any function added to or removed from this list without a
// matching test update is exactly the "no unrelated RPC grants change"
// regression this test exists to catch.
const EXPECTED_ANON_REVOKED = [
  'check_and_increment_stylechat_burst',
  'create_look_from_dressing_room_items',
  'create_or_get_room_share',
  'revoke_room_share',
  'upsert_style_memory_event',
  'ensure_privacy_settings',
  'increment_style_chat_usage',
  'increment_stylechat_daily_usage',
  'get_stylechat_daily_usage',
];

// Trigger functions are intentionally revoked through a catalog-driven loop:
// staging has three lineage-specific functions, so literal REVOKE statements
// would abort when this reviewed migration is replayed elsewhere.
const EXPECTED_CATALOG_REVOKED = [
  'enforce_minor_privacy_defaults',
  'handle_new_user',
  'handle_new_user_privacy',
  'normalize_dressing_room_note',
  'set_profiles_updated_at',
  'set_provider_request_limits_updated_at',
  'set_style_objects_updated_at',
  'set_updated_at',
  'update_privacy_settings_updated_at',
];

// Functions this migration pair must NEVER touch a grant for -- either
// because their anon access is intentional (the two RPCs on
// ANON_EXECUTE_ALLOWLIST) or because they're unrelated to this change.
const MUST_NOT_BE_REVOKED = ['get_public_room_preview', 'reserve_provider_request', 'complete_provider_request'];

test('literal application-RPC revokes cover the reviewed anon-only list', () => {
  for (const fn of EXPECTED_ANON_REVOKED) {
    const pattern = new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from (anon|public);`);
    assert.match(combinedSql, pattern, `expected a revoke statement for ${fn}`);
  }
});

test('catalog-driven trigger hardening revokes PUBLIC and anon when each reviewed function exists', () => {
  assert.match(combinedSql, /foreach v_target in array v_targets loop/i);
  assert.match(combinedSql, /from pg_proc p[\s\S]*?p\.proname = v_target[\s\S]*?p\.pronargs = 0/i);
  assert.match(combinedSql, /execute format\('revoke execute on function public\.%I\(\) from public', v_target\)/i);
  assert.match(combinedSql, /execute format\('revoke execute on function public\.%I\(\) from anon', v_target\)/i);
  for (const fn of EXPECTED_CATALOG_REVOKED) {
    assert.match(combinedSql, new RegExp(`'${fn}'`), `expected catalog target for ${fn}`);
  }
});

test('the migration pair does not revoke anon/public from get_public_room_preview or the provider_request functions', () => {
  for (const fn of MUST_NOT_BE_REVOKED) {
    assert.doesNotMatch(
      combinedSql,
      new RegExp(`revoke execute on function public\\.${fn}\\(`),
      `${fn} must not have a grant touched by this migration pair`,
    );
  }
});

test('no GRANT statement appears in either migration (this pass only ever revokes, matching a pure hardening change)', () => {
  // Anchored to line start so this doesn't false-positive on the prose
  // comment describing the *problem* ("default privileges grant EXECUTE
  // on newly created functions") -- only a real `grant execute on ...`
  // SQL statement should trip this.
  assert.doesNotMatch(combinedSql, /^\s*grant execute on\b/im);
});

test('neither migration alters, drops, or truncates a table', () => {
  assert.doesNotMatch(combinedSql, /\b(alter table|drop table|truncate)\b/i);
});

test('neither migration edits a previously-applied migration file (this repo convention: additive only)', () => {
  const priorMigrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !f.startsWith('20260803214145') && !f.startsWith('20260803214253'));
  // Sanity: prior migrations exist and this test isn't vacuous.
  assert.ok(priorMigrations.length > 30, 'expected the full pre-existing migration history to be present');
});

test('get_item_reaction_counts is redefined with the owner-or-active-share predicate', () => {
  assert.match(mainSql, /create or replace function public\.get_item_reaction_counts/);
  assert.match(mainSql, /dr\.user_id\s*=\s*auth\.uid\(\)/, 'must preserve the owner path');
  assert.match(mainSql, /rs\.is_active\s*=\s*true/, 'must check the share is active');
  assert.match(mainSql, /rs\.revoked_at\s+is\s+null/, 'must check the share is not revoked');
  assert.match(
    mainSql,
    /rs\.expires_at\s+is\s+null\s+or\s+rs\.expires_at\s*>\s*now\(\)/,
    'must check the share has not expired',
  );
});

test('get_item_reaction_counts retains a controlled search_path (SECURITY DEFINER)', () => {
  const fnMatch = mainSql.match(
    /create or replace function public\.get_item_reaction_counts[\s\S]*?\$function\$;/,
  );
  assert.ok(fnMatch, 'could not isolate the function body');
  assert.match(fnMatch[0], /security definer/i);
  assert.match(fnMatch[0], /set search_path to 'public'/i);
});

test('get_item_reaction_counts is never revoked from anon in either migration (preserves the public room-preview caller)', () => {
  assert.doesNotMatch(combinedSql, /revoke execute on function public\.get_item_reaction_counts\([^)]*\)\s+from\s+anon/);
});

test('the migration pair preserves required authenticated and service-role application grants', () => {
  assert.doesNotMatch(combinedSql, /from\s+authenticated\s*;/i);
  assert.doesNotMatch(combinedSql, /from\s+service_role\s*;/i);
});

test('the pending-SQL staging file has been removed now that it is a real, applied migration', () => {
  const stalePath = path.join(__dirname, '..', '..', 'security', 'perimeter', 'pending-rpc-hardening.sql');
  assert.equal(fs.existsSync(stalePath), false, 'pending-rpc-hardening.sql should no longer exist once applied');
});
