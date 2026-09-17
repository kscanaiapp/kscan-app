/**
 * B34-SEC-003 — get_item_reaction_counts() must bind its anonymous branch to
 * the SPECIFIC live share token the caller holds, not to "this room has some
 * live share".
 *
 * #431 (B34-SEC-001) closed the authenticated non-owner leak: a removed member
 * or unrelated authenticated account can no longer read reaction counts while
 * presenting a JWT. It left the anonymous branch as `exists (a live share for
 * this room)`, with no per-caller binding at all — the RPC takes only item
 * ids, no token. So the same removed member (or anyone else who retains the
 * item ids) could omit the Authorization header and land in the anonymous
 * branch, which the room's share state alone satisfies whenever the room has
 * any live share. Dropping identity must never be a privilege-escalation path.
 *
 * This suite guards the corrected migration
 * 20260917010000_reaction_counts_bind_anonymous_share_token.sql, which is the
 * last word on the function and must stay that way.
 *
 * Behavioural assertions live in
 * supabase/tests/reaction_counts_room_access_test.sql and need a database.
 * This file is the guard that runs in the normal suite, so a migration that
 * silently loses a clause is caught by something.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const MIGRATION = 'supabase/migrations/20260917010000_reaction_counts_bind_anonymous_share_token.sql';

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

test('B34-SEC-003: the corrected migration is the last word on the RPC', () => {
  const latest = latestDefinition();
  assert.ok(latest, 'no migration defines get_item_reaction_counts');
  assert.equal(
    latest.file,
    '20260917010000_reaction_counts_bind_anonymous_share_token.sql',
    'a later migration redefined the RPC; re-verify it still binds the anonymous branch to a token',
  );
});

test('B34-SEC-003: the RPC takes a share-token parameter', () => {
  const { body } = latestDefinition();
  assert.match(
    body,
    /p_share_token text default null/,
    'the anonymous branch has nothing to bind to without a token parameter',
  );
});

test('B34-SEC-003: the old single-argument signature is dropped, not overloaded', () => {
  const migration = read(MIGRATION);
  assert.match(
    migration,
    /drop function if exists public\.get_item_reaction_counts\(uuid\[\]\);/,
    'a coexisting one-arg overload would let a caller silently resolve to the old, unbound anonymous predicate',
  );
});

test('B34-SEC-003: the anonymous branch requires a token match against room_shares, not mere existence', () => {
  const { body } = latestDefinition();
  const anonBranch = body.slice(body.indexOf('when caller.uid is null then'), body.indexOf('else'));
  assert.match(
    anonBranch,
    /normalized_token\.token is not null/,
    'a null/absent token must not satisfy the anonymous branch',
  );
  assert.match(
    anonBranch,
    /rs\.share_token = normalized_token\.token/,
    'the anonymous branch must check the SPECIFIC token, not merely that some share row exists',
  );
});

test('B34-SEC-003: the #431 authenticated non-owner repair is preserved', () => {
  const { body } = latestDefinition();
  const authedBranch = body.slice(body.indexOf('else'));
  assert.match(
    authedBranch,
    /from public\.shared_room_memberships m/,
    'the authenticated branch must still consult the membership recipient model',
  );
  assert.match(
    authedBranch,
    /m\.recipient_user_id = caller\.uid/,
    'membership must be bound to the calling user, not merely exist',
  );
  assert.match(
    authedBranch,
    /m\.removed_at is null/,
    'removal must end access',
  );
  assert.match(
    authedBranch,
    /or public\.can_access_room_messages\(dr\.id\)/,
    'the participant recipient model must be honoured via the governed predicate',
  );
  assert.match(
    authedBranch,
    /not internal\.is_dressing_room_pair_blocked\(dr\.user_id, caller\.uid\)/,
    '20260902130000 block-check hardening must not regress',
  );
});

test('B34-SEC-003: owner branch and live-share liveness clauses are preserved', () => {
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

test('B34-SEC-003: security context is unchanged', () => {
  const { body } = latestDefinition();
  assert.match(body, /security definer/, 'must remain SECURITY DEFINER to read across owners');
  assert.match(
    body,
    /set search_path = pg_catalog, public/,
    'search_path must stay pinned per the hardened-siblings convention',
  );
});

test('B34-SEC-003: grants are restated explicitly for the new signature', () => {
  const migration = read(MIGRATION);
  assert.match(migration, /grant execute on function public\.get_item_reaction_counts\(uuid\[\], text\) to anon;/);
  assert.match(
    migration,
    /grant execute on function public\.get_item_reaction_counts\(uuid\[\], text\) to authenticated;/,
  );
});

test('B34-SEC-003: the client threads a share token for the public-share screen', () => {
  const service = read('services/styleObjects.ts');
  assert.match(
    service,
    /export async function getItemReactionCounts\(\s*\n\s*itemIds: string\[\],\s*\n\s*shareToken\?: string \| null,/,
    'getItemReactionCounts must accept an optional share token to forward to the RPC',
  );
  assert.match(
    service,
    /p_share_token: normalizedToken \|\| null,/,
    'the share token must be forwarded to the RPC call',
  );

  const publicRoomScreen = read('app/(public)/rooms/[token].tsx');
  assert.match(
    publicRoomScreen,
    /getItemReactionCounts\(itemIds, rawToken\)/,
    'the public share screen must pass its route token through to getItemReactionCounts',
  );
});

test('B34-SEC-003: the authenticated in-app screen is unchanged (no token to send)', () => {
  const dressingRoomScreen = read('app/dressing-rooms/[id].tsx');
  assert.match(
    dressingRoomScreen,
    /getItemReactionCounts\(reactionItemIds\)/,
    'the authenticated screen resolves via the authenticated branch and needs no token argument',
  );
});
