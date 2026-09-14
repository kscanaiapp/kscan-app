#!/usr/bin/env node
'use strict';

/**
 * Regression controls for the AUTHENTICATED cross-actor definer class.
 *
 * Two layers, both required:
 *
 *   1. The guard itself (security/scripts/actor-scoped-definer-guard.js) --
 *      pure-function tests, including a live-shaped fixture reproducing the
 *      build_owned_item_snapshot defect exactly as it was observed on staging
 *      (yzqjvdfgefveprobvvyw) before repair.
 *
 *   2. The migration text
 *      (supabase/migrations/20260914120000_close_authenticated_cross_actor_owned_item_snapshot.sql)
 *      -- structural assertions, in the same spirit as
 *      rpcHardeningMigration.test.js, so a later edit that drops the revoke or
 *      the in-body actor gate is caught here rather than in another audit.
 *
 * There is no live Postgres in this test run. Live behavior was proven against
 * staging with synthetic User A / User B actors; see the Commerce actor-isolation
 * audit record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ACTOR_UNCHECKED_DEFINER_ALLOWLIST,
  LIVE_INVENTORY_SQL,
  hasActorParameter,
  detectActorUncheckedDefiners,
  detectStaleActorAllowlistEntries,
} = require('../../security/scripts/actor-scoped-definer-guard');

const MIGRATION = path.join(
  __dirname, '..', '..', 'supabase', 'migrations',
  '20260914120000_close_authenticated_cross_actor_owned_item_snapshot.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');

// ── 1. The guard ───────────────────────────────────────────────────────────

test('hasActorParameter: recognises the owner/user parameter shapes', () => {
  assert.equal(hasActorParameter('p_source_type text, p_source_id uuid, p_owner_id uuid'), true);
  assert.equal(hasActorParameter('p_user_id uuid, p_function_name text'), true);
  assert.equal(hasActorParameter('p_target_user_id uuid'), true);
  assert.equal(hasActorParameter('p_limit integer'), false);
  assert.equal(hasActorParameter(''), false);
  assert.equal(hasActorParameter(undefined), false);
});

test('detectActorUncheckedDefiners: reproduces the build_owned_item_snapshot defect', () => {
  // The live row exactly as staging reported it BEFORE the repair.
  const preRepair = [{
    functionName: 'build_owned_item_snapshot',
    args: 'p_source_type text, p_source_id uuid, p_owner_id uuid',
    securityDefiner: true,
    authenticatedCanExecute: true,
    bodyChecksAuthUid: false,
  }];
  assert.deepEqual(detectActorUncheckedDefiners(preRepair), ['build_owned_item_snapshot']);
});

test('detectActorUncheckedDefiners: the repaired shape is not flagged (revoked grant)', () => {
  const postRepair = [{
    functionName: 'build_owned_item_snapshot',
    args: 'p_source_type text, p_source_id uuid, p_owner_id uuid',
    securityDefiner: true,
    authenticatedCanExecute: false,
    bodyChecksAuthUid: true,
  }];
  assert.deepEqual(detectActorUncheckedDefiners(postRepair), []);
});

test('detectActorUncheckedDefiners: a grant restored WITHOUT the body gate is flagged again', () => {
  // Default privileges re-granting EXECUTE is how this arose in the first
  // place, so the guard must still fire if only the revoke is undone.
  const regranted = [{
    functionName: 'build_owned_item_snapshot',
    args: 'p_source_type text, p_source_id uuid, p_owner_id uuid',
    securityDefiner: true,
    authenticatedCanExecute: true,
    bodyChecksAuthUid: false,
  }];
  assert.deepEqual(detectActorUncheckedDefiners(regranted), ['build_owned_item_snapshot']);
});

test('detectActorUncheckedDefiners: a definer that checks auth.uid() is not flagged', () => {
  const checked = [{
    functionName: 'evaluate_provider_abuse_state',
    args: 'p_user_id uuid, p_function_name text',
    securityDefiner: true,
    authenticatedCanExecute: true,
    bodyChecksAuthUid: true,
  }];
  assert.deepEqual(detectActorUncheckedDefiners(checked), []);
});

test('detectActorUncheckedDefiners: service-role-only definers are not flagged', () => {
  // create_user_commerce_watch and friends take p_user_id but hold no
  // authenticated grant, so the Data API cannot reach them at all.
  const serviceOnly = [{
    functionName: 'create_user_commerce_watch',
    args: 'p_user_id uuid, p_source text',
    securityDefiner: true,
    authenticatedCanExecute: false,
    bodyChecksAuthUid: false,
  }];
  assert.deepEqual(detectActorUncheckedDefiners(serviceOnly), []);
});

test('detectActorUncheckedDefiners: an INVOKER function is never flagged', () => {
  const invoker = [{
    functionName: 'signature_style_frequency',
    args: 'p_values text[]',
    securityDefiner: false,
    authenticatedCanExecute: true,
    bodyChecksAuthUid: false,
  }];
  assert.deepEqual(detectActorUncheckedDefiners(invoker), []);
});

test('detectActorUncheckedDefiners: a mixed snapshot flags only the unsafe function', () => {
  const mixed = [
    { functionName: 'build_owned_item_snapshot', args: 'p_source_type text, p_source_id uuid, p_owner_id uuid', securityDefiner: true, authenticatedCanExecute: true, bodyChecksAuthUid: false },
    { functionName: 'evaluate_provider_abuse_state', args: 'p_user_id uuid, p_function_name text', securityDefiner: true, authenticatedCanExecute: true, bodyChecksAuthUid: true },
    { functionName: 'has_active_k_plus', args: '', securityDefiner: true, authenticatedCanExecute: true, bodyChecksAuthUid: true },
  ];
  assert.deepEqual(detectActorUncheckedDefiners(mixed), ['build_owned_item_snapshot']);
});

test('the allowlist is empty: no caller-supplied actor is approved while RLS is bypassed', () => {
  assert.deepEqual(ACTOR_UNCHECKED_DEFINER_ALLOWLIST, []);
});

test('detectStaleActorAllowlistEntries: an allowlisted name that is no longer risky is surfaced', () => {
  const live = [{
    functionName: 'some_repaired_fn',
    args: 'p_user_id uuid',
    securityDefiner: true,
    authenticatedCanExecute: false,
    bodyChecksAuthUid: true,
  }];
  assert.deepEqual(detectStaleActorAllowlistEntries(live, ['some_repaired_fn']), ['some_repaired_fn']);
});

test('LIVE_INVENTORY_SQL selects the five fields the guard consumes', () => {
  for (const field of ['functionName', 'args', 'securityDefiner', 'authenticatedCanExecute', 'bodyChecksAuthUid']) {
    assert.ok(LIVE_INVENTORY_SQL.includes(`"${field}"`) || LIVE_INVENTORY_SQL.includes(field),
      `LIVE_INVENTORY_SQL is missing ${field}`);
  }
  assert.ok(LIVE_INVENTORY_SQL.includes("n.nspname = 'public'"), 'inventory must be scoped to the exposed schema');
});

// ── 2. The migration ───────────────────────────────────────────────────────

test('migration revokes authenticated EXECUTE on build_owned_item_snapshot', () => {
  assert.match(
    sql,
    /revoke execute on function public\.build_owned_item_snapshot\(text, uuid, uuid\) from authenticated;/i,
    'the revoke that closes the Data-API path is missing',
  );
});

test('migration reasserts all three revokes AFTER create or replace', () => {
  // CREATE OR REPLACE resets the ACL to the defaults in force, so a revoke
  // placed before it would be silently undone.
  const replaceAt = sql.search(/create or replace function public\.build_owned_item_snapshot/i);
  assert.ok(replaceAt > -1, 'migration does not replace the function body');
  const tail = sql.slice(replaceAt);
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(
      tail,
      new RegExp(`revoke all on function public\\.build_owned_item_snapshot\\(text, uuid, uuid\\) from ${role};`, 'i'),
      `the ${role} revoke does not follow CREATE OR REPLACE`,
    );
  }
});

test('migration adds an in-body actor gate against auth.uid()', () => {
  assert.match(sql, /auth\.uid\(\)/, 'the function body never consults the verified session');
  assert.match(
    sql,
    /p_owner_id\s+is\s+null\s+or\s+auth\.uid\(\)\s+is\s+null\s+or\s+p_owner_id\s*<>\s*auth\.uid\(\)/i,
    'the actor gate must refuse a null actor as well as a mismatched one',
  );
});

test('migration keeps the function SECURITY DEFINER with a pinned search_path', () => {
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path to 'public'/i);
});

test('migration does not weaken the ownership filters it already had', () => {
  const ownershipFilters = sql.match(/and user_id = p_owner_id/gi) ?? [];
  assert.equal(ownershipFilters.length, 2,
    'both the saved_scan and inspiration_item branches must still filter on the owner');
});

test('migration is privilege- and body-only: no table, policy, or unrelated object is touched', () => {
  for (const forbidden of [/create table/i, /drop table/i, /alter table/i, /create policy/i, /drop policy/i]) {
    assert.equal(forbidden.test(sql), false, `migration performs a schema change: ${forbidden}`);
  }
  // The only function it defines is the one it repairs.
  const defined = sql.match(/create or replace function public\.(\w+)/gi) ?? [];
  assert.deepEqual(defined.map((d) => d.split('.').pop()), ['build_owned_item_snapshot']);
});
