/**
 * B34-SEC-001 — get_item_reaction_counts() must require the caller to HOLD
 * access, not merely observe that the room has a live share.
 *
 * The non-owner branch tested only `exists (a live room_shares row for this
 * room)`. Because the function is SECURITY DEFINER and granted to anon and
 * authenticated, that single predicate was the whole authorization boundary for
 * every non-owner. Proven on staging yzqjvdfgefveprobvvyw against synthetic
 * fixtures, with the table's own RLS as the control — same principal, same item,
 * opposite answers:
 *
 *   anon, no JWT                  dressing_room_items 0 rows   rpc like=1,...
 *   authenticated non-member      dressing_room_items 0 rows   rpc like=1,...
 *   authenticated REMOVED member  dressing_room_items 0 rows   rpc like=1,...
 *
 * and the negative control (share revoked, anon) returned nothing, confirming
 * share liveness was the only gate. The removed-member row is the defect that
 * matters: removal is meant to end access, RLS honours it, this did not.
 * 20260902130000_reaction_counts_honour_dressing_room_block.sql closed the same
 * shape for BLOCKED users; removal was missed by that pass.
 *
 * Post-fix on staging: outsider and removed member both return no rows, while
 * owner, active membership, active participant and the anonymous public preview
 * all still return counts.
 *
 * The anonymous branch is deliberately unchanged — see the migration header.
 * app/(public)/rooms/[token].tsx is unauthenticated by design and reaches this
 * RPC with item ids only, so the share link is the capability and its liveness
 * is the bound, exactly as for get_public_room_preview.
 *
 * Behavioural assertions live in
 * supabase/tests/reaction_counts_room_access_test.sql and need a database. This
 * file is the guard that runs in the normal suite, so a migration that silently
 * loses a clause is caught by something.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const MIGRATION = 'supabase/migrations/20260916203000_reaction_counts_require_live_room_access.sql';
const PGTAP = 'supabase/tests/reaction_counts_room_access_test.sql';

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** The final definition of the RPC across all migrations, in file order. */
function latestDefinition() {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();

  let latest = null;
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    const marker = /create or replace function public\.get_item_reaction_counts\s*\(/i;
    const match = marker.exec(source);
    if (!match) continue;
    const body = source.slice(match.index);
    const end = body.indexOf('$function$;');
    latest = { file: name, body: end === -1 ? body : body.slice(0, end + 11) };
  }
  return latest;
}

test('B34-SEC-001: the repair migration is the last word on the RPC', () => {
  const latest = latestDefinition();
  assert.ok(latest, 'no migration defines get_item_reaction_counts');
  assert.equal(
    latest.file,
    '20260916203000_reaction_counts_require_live_room_access.sql',
    'a later migration redefined the RPC; re-verify it still requires held access',
  );
});

test('B34-SEC-001: an authenticated non-owner must hold a live membership or room access', () => {
  const { body } = latestDefinition();
  assert.match(
    body,
    /from public\.shared_room_memberships m/,
    'the authenticated branch must consult the membership recipient model',
  );
  assert.match(
    body,
    /m\.recipient_user_id = caller\.uid/,
    'membership must be bound to the calling user, not merely exist',
  );
  assert.match(
    body,
    /or public\.can_access_room_messages\(dr\.id\)/,
    'the participant recipient model must be honoured via the governed predicate',
  );
});

test('B34-SEC-001: removed recipients are excluded', () => {
  const { body } = latestDefinition();
  assert.match(
    body,
    /m\.removed_at is null/,
    'removal must end access; this is the clause the pre-fix predicate lacked',
  );
});

test('B34-SEC-001: the bare share-existence test no longer gates authenticated callers', () => {
  const { body } = latestDefinition();
  // The share-existence EXISTS survives only inside the anonymous branch. It
  // must be guarded by the null-caller case, never reachable with an identity.
  assert.match(
    body,
    /when caller\.uid is null then/,
    'the share-existence predicate must be confined to the anonymous branch',
  );
  const anonBranch = body.slice(body.indexOf('when caller.uid is null then'), body.indexOf('else'));
  assert.match(anonBranch, /from public\.room_shares rs/);
  const authedBranch = body.slice(body.indexOf('else'));
  assert.ok(
    !/from public\.room_shares rs\s*\n\s*where rs\.room_id = dr\.id\s*\n\s*and rs\.is_active/.test(
      authedBranch.slice(0, authedBranch.indexOf('shared_room_memberships')),
    ),
    'an authenticated caller must not be admitted by share existence alone',
  );
});

test('B34-SEC-001: the block check is preserved for identified callers', () => {
  const { body } = latestDefinition();
  assert.match(
    body,
    /not internal\.is_dressing_room_pair_blocked\(dr\.user_id, caller\.uid\)/,
    '20260902130000 hardening must not regress',
  );
});

test('B34-SEC-001: owner branch and live-share clauses are preserved', () => {
  const { body } = latestDefinition();
  assert.match(body, /dr\.user_id = caller\.uid/, 'the owner branch must remain');
  for (const clause of [
    'rs.is_active = true',
    'rs.revoked_at is null',
    'rs.expires_at is null or rs.expires_at > now()',
  ]) {
    assert.ok(body.includes(clause), `pre-existing clause lost: ${clause}`);
  }
});

test('B34-SEC-001: signature, security context and grants are unchanged', () => {
  const migration = read(MIGRATION);
  assert.match(
    migration,
    /returns table\(item_id uuid, reaction_type text, count integer\)\s*\n\s*language sql\s*\n\s*security definer/,
    'the caller contract must not move',
  );
  assert.match(migration, /set search_path = pg_catalog, public/);
  // The anon grant is deliberate and load-bearing: revoking it would break the
  // unauthenticated public share screen. See security/scripts/anon-grant-guard.js.
  assert.match(
    migration,
    /grant execute on function public\.get_item_reaction_counts\(uuid\[\]\) to anon/,
    'the public preview must keep working',
  );
  assert.match(
    migration,
    /grant execute on function public\.get_item_reaction_counts\(uuid\[\]\) to authenticated/,
  );
  assert.match(migration, /revoke all on function public\.get_item_reaction_counts\(uuid\[\]\) from public/);
  assert.ok(!/drop function/i.test(migration), 'replacing the body must not drop the function');
  assert.ok(!/drop policy/i.test(migration), 'this repair must not disturb any RLS policy');
});

test('B34-SEC-001: the behavioural pgTAP companion exists and covers both leak paths', () => {
  const pgtap = read(PGTAP);
  for (const marker of [
    'authenticated outsider',
    'removed member',
    'anonymous public preview',
    'active membership',
    'active participant',
  ]) {
    assert.ok(pgtap.includes(marker), `pgTAP suite is missing coverage: ${marker}`);
  }
});
