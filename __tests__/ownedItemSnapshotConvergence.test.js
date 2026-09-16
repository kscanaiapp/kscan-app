/**
 * BUILD 34 STAGING-TO-RELEASE SECURITY CONVERGENCE.
 *
 * `public.build_owned_item_snapshot(text, uuid, uuid)` is SECURITY DEFINER and
 * takes the owner it scopes to as a PARAMETER. Its defining migration
 * (20260711000001) revoked EXECUTE from `public` and `anon` but not from
 * `authenticated`, and this project's default privileges grant EXECUTE on new
 * public-schema functions -- so PostgREST exposed it as
 * POST /rest/v1/rpc/build_owned_item_snapshot to any signed-in user, and
 * SECURITY DEFINER bypassed the RLS that otherwise protects saved_scans.
 *
 * The hardening that closes it was authored on
 * fix/notifications-final-convergence-v1 and applied to STAGING, but landed in
 * no merged branch. Staging's governed deploy preflight therefore reported it
 * as undeclared remote-only drift and blocked every staging deployment.
 *
 * THIS FILE IS THE CONVERGENCE, AND NOTHING ELSE. It carries the one narrow
 * security migration into release authority at its original authored version,
 * plus the reconciliation entry that records the version staging actually
 * assigned it. No notification work, no Build 35 feature, no unrelated
 * migration travels with it -- and these tests are what keep that true.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_REL = 'supabase/migrations/20260914120000_close_authenticated_cross_actor_owned_item_snapshot.sql';
const MIGRATION = fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'migration-authority-manifest.json'), 'utf8'),
);
const STAGING_REF = 'yzqjvdfgefveprobvvyw';

/** Executable SQL only: comments explain, they do not execute. */
function executable(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

test('the hardening removes authenticated reachability of the definer helper', () => {
  const sql = executable(MIGRATION);
  assert.match(
    sql,
    /revoke execute on function public\.build_owned_item_snapshot\(text, uuid, uuid\) from authenticated;/,
  );
  // CREATE OR REPLACE resets the ACL, so the revokes must be reasserted AFTER
  // the body change or the fix silently undoes itself.
  const replaceAt = sql.indexOf('create or replace function public.build_owned_item_snapshot');
  assert.ok(replaceAt > 0, 'the function body is not redefined');
  const afterReplace = sql.slice(replaceAt);
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(
      afterReplace,
      new RegExp(`revoke all on function public\\.build_owned_item_snapshot\\(text, uuid, uuid\\) from ${role};`),
      `the post-redefinition revoke for ${role} is missing -- CREATE OR REPLACE would restore its grant`,
    );
  }
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.build_owned_item_snapshot[^;]*to (authenticated|anon|public)/i,
  );
});

test('defense in depth: the actor gate checks the owner parameter against the session', () => {
  const sql = executable(MIGRATION);
  assert.match(sql, /if p_owner_id is null or auth\.uid\(\) is null or p_owner_id <> auth\.uid\(\) then/);
  // It returns null rather than raising: the wrappers already treat a null
  // snapshot as "unavailable", so the refusal reveals nothing about existence.
  const gateAt = sql.indexOf('if p_owner_id is null or auth.uid() is null');
  assert.match(sql.slice(gateAt, gateAt + 160), /return null;/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path to 'public'/);
});

test('privilege- and body-only: no table, policy or unrelated object is touched', () => {
  const sql = executable(MIGRATION);
  for (const forbidden of [
    /create table/i,
    /alter table/i,
    /drop table/i,
    /create policy/i,
    /drop policy/i,
    /drop function/i,
    /create index/i,
  ]) {
    assert.doesNotMatch(sql, forbidden);
  }
  // Exactly one function is redefined, and it is the one named.
  const redefinitions = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(redefinitions, ['build_owned_item_snapshot']);
});

test('SCOPE GUARD: nothing from the source branch travels with the hardening', () => {
  const sql = MIGRATION.toLowerCase();
  // The source branch is a notifications / Build 35 convergence lane. None of
  // its subject matter may ride along inside this file.
  for (const foreign of [
    'push_token',
    'notification',
    'device_push',
    'watchlist',
    'commerce_watch',
    'kplus',
    'entitlement',
  ]) {
    assert.ok(!sql.includes(foreign), `unrelated subject "${foreign}" leaked into the convergence migration`);
  }
});

test('the reconciliation entry is a proven EXACT_CONTENT_RENUMBER, not an asserted one', () => {
  const env = MANIFEST.ledgerReconciliation.environments[STAGING_REF];
  assert.ok(env, 'staging reconciliation authority is missing');
  const entry = env.reconciled.find((e) => e.localVersion === '20260914120000');
  assert.ok(entry, 'no reconciliation entry for the converged migration');

  assert.equal(entry.logicalName, 'close_authenticated_cross_actor_owned_item_snapshot');
  assert.deepEqual(entry.remoteVersions, ['20260914201155']);
  assert.equal(entry.classification, 'EXACT_CONTENT_RENUMBER');

  // The evidence must cite the proof, not merely claim the conclusion. The hash
  // is the whole point: it is what separates this from declaring an unexplained
  // orphan "reconciled".
  assert.match(entry.evidence, /23a939056a54927124b2eb3eaf42f01b/,
    'the evidence must carry the normalized-content hash that proves identity');
  assert.match(entry.evidence, /fix\/notifications-final-convergence-v1/,
    'the evidence must name the branch the content came from');
  assert.match(entry.evidence, /d66f03d/, 'the evidence must name the source commit');
});

test('the localVersion the entry claims is really in the tree, at that exact version', () => {
  // A reconciliation entry pointing at a file that does not exist is stale
  // authority, which the preflight treats as a blocker rather than a licence.
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const matches = fs.readdirSync(dir).filter((n) => n.startsWith('20260914120000_'));
  assert.deepEqual(matches, ['20260914120000_close_authenticated_cross_actor_owned_item_snapshot.sql']);
  assert.ok(fs.existsSync(path.join(ROOT, MIGRATION_REL)));
});

test('the remote version is claimed exactly once across the whole staging authority', () => {
  const env = MANIFEST.ledgerReconciliation.environments[STAGING_REF];
  const claims = env.reconciled.flatMap((e) => (Array.isArray(e.remoteVersions) ? e.remoteVersions : []));
  const duplicates = claims.filter((v, i) => claims.indexOf(v) !== i);
  assert.deepEqual(duplicates, [], `a remote ledger row is claimed twice: ${duplicates.join(', ')}`);
  assert.equal(claims.filter((v) => v === '20260914201155').length, 1);
});
