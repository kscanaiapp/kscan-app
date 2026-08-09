/**
 * GP-004 — the Dressing Room contribution predicate must enforce the block.
 *
 * public.can_contribute_to_dressing_room() backs three RLS policies on
 * dressing_room_items (contributor INSERT / UPDATE / DELETE). It was written by
 * 20260725100000_shared_room_item_contributions.sql, before account-level
 * blocking existed, and 20260806153233_dressing_room_user_blocking.sql
 * retrofitted internal.is_dressing_room_pair_blocked() into every messaging and
 * access path without reaching it. block_dressing_room_user() marks participant
 * rows left_at rather than deleting them and deliberately leaves the share
 * active, so a blocked participant still satisfied the predicate and could
 * INSERT items into the room they were blocked from.
 *
 * Proven in a disposable Postgres 16 container on 2026-08-09 by running the
 * deployed predicate and the repaired one side by side over the same fixture:
 * blocked participant BEFORE=true, AFTER=false, with owner / unrelated
 * participant / stranger / re-redemption cases identical across both.
 *
 * This file is the guard that runs in the normal suite; the behavioural
 * assertions live in supabase/tests/dressing_room_contribution_blocking_test.sql
 * and need a database. Both are required: the pgTAP file cannot run here, and a
 * migration that silently loses a clause would otherwise be caught by nothing.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const MIGRATION = 'supabase/migrations/20260809120000_contribution_block_enforcement.sql';
const PGTAP = 'supabase/tests/dressing_room_contribution_blocking_test.sql';

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** The final definition of the predicate across all migrations, in file order. */
function latestPredicateDefinition() {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let latest = null;
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    const marker = /create or replace function public\.can_contribute_to_dressing_room\s*\(/i;
    const match = marker.exec(source);
    if (!match) continue;
    const body = source.slice(match.index);
    const end = body.indexOf('$$;');
    latest = { file: name, body: end === -1 ? body : body.slice(0, end + 3) };
  }
  return latest;
}

test('GP-004: the repair migration exists and is the last word on the predicate', () => {
  const latest = latestPredicateDefinition();
  assert.ok(latest, 'no migration defines can_contribute_to_dressing_room');
  assert.equal(
    latest.file,
    '20260809120000_contribution_block_enforcement.sql',
    'a later migration redefined the predicate; re-verify it still enforces the block',
  );
});

test('GP-004: the predicate consults the block helper', () => {
  const { body } = latestPredicateDefinition();
  assert.match(
    body,
    /not\s+internal\.is_dressing_room_pair_blocked\(\s*dr\.user_id\s*,\s*drp\.user_id\s*\)/,
    'the participant branch must exclude blocked pairs',
  );
});

test('GP-004: the predicate excludes participants who have left', () => {
  const { body } = latestPredicateDefinition();
  assert.match(
    body,
    /drp\.left_at is null/,
    'block_dressing_room_user marks left_at rather than deleting the row',
  );
});

test('GP-004: the predicate binds the share to the current room owner', () => {
  const { body } = latestPredicateDefinition();
  assert.match(body, /rs\.owner_id = dr\.user_id/, 'share issuer must be the current owner');
  assert.match(
    body,
    /dr\.user_id is distinct from \(select auth\.uid\(\)\)/,
    'the participant branch must not be satisfiable by the owner',
  );
});

test('GP-004: the owner branch and the live-share conditions are preserved', () => {
  const { body } = latestPredicateDefinition();
  // Owner of the room contributes unconditionally — an owner blocked by every
  // participant keeps their own room usable.
  assert.match(body, /from public\.dressing_rooms dr\s*\n\s*where dr\.id = p_room_id\s*\n\s*and dr\.user_id = \(select auth\.uid\(\)\)/);
  for (const clause of [
    'rs.is_active = true',
    'rs.revoked_at is null',
    'rs.expires_at is null or rs.expires_at > now()',
  ]) {
    assert.ok(body.includes(clause), `pre-existing clause lost: ${clause}`);
  }
});

test('GP-004: signature, volatility and grants are unchanged', () => {
  const migration = read(MIGRATION);
  assert.match(migration, /returns boolean\s*\n\s*language sql\s*\n\s*stable\s*\n\s*security definer/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /revoke all on function public\.can_contribute_to_dressing_room\(uuid\) from anon/);
  assert.match(
    migration,
    /grant execute on function public\.can_contribute_to_dressing_room\(uuid\) to authenticated/,
  );
  assert.ok(
    !/drop policy/i.test(migration),
    'replacing the body must not disturb the three RLS policies that call it',
  );
});

test('GP-004: the migration is marked as not-yet-deployed to production', () => {
  const migration = read(MIGRATION);
  assert.match(
    migration,
    /NOT APPLIED TO PRODUCTION/,
    'deployment state must be explicit in the migration header',
  );
});

test('GP-004: pgTAP coverage for contribution blocking exists', () => {
  const pgtap = read(PGTAP);
  assert.match(pgtap, /can_contribute_to_dressing_room/);
  assert.match(pgtap, /block_dressing_room_user/);
  assert.match(pgtap, /dressing_room_items/, 'the RLS policy itself must be asserted, not only the helper');

  // The plan count must match the assertions actually present, or pgTAP
  // reports a plan mismatch that reads as noise rather than a failure.
  const planned = Number(/select plan\((\d+)\)/.exec(pgtap)[1]);
  const actual = (pgtap.match(/\bselect (ok|throws_ok|is|isnt)\(/g) || []).length;
  assert.equal(actual, planned, `plan(${planned}) but ${actual} assertions present`);
});
