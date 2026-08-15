/**
 * KSB29-029 / KSB29-030 / KSB29-031 — blocking on EVERY path to a shared room.
 *
 * 20260806153233_dressing_room_user_blocking.sql taught `dressing_rooms` to
 * refuse a blocked recipient, and that policy genuinely works. It did not teach
 * the sibling paths, so blocking held on the room SHELL while every other route
 * to the same content stayed open:
 *
 *   1. `dressing_room_items` — the recipient SELECT policy validated the share
 *      but never consulted the block relation. A blocked recipient was denied
 *      the room and could still read EVERY ITEM IN IT by querying the items
 *      table directly. Hiding the shell while serving the contents is not
 *      blocking.
 *
 *   2. `list_shared_rooms_for_me`, `save_shared_room_for_me` and
 *      `touch_shared_room_for_me` are SECURITY DEFINER, so RLS never runs for
 *      them and the check has to be explicit. None had it, so a blocked user
 *      could still see the room listed as `available` with its title and item
 *      count, still SAVE it, and still refresh its access time.
 *
 * Live state read from BOTH projects on 2026-08-15, before writing:
 *
 *                                          staging   production
 *   dressing_rooms   recipient policy       block ✓    block ✓
 *   dressing_room_items recipient policy    block ✗    block ✗
 *   list/save/touch RPCs                    block ✗    block ✗
 *
 * The migration was applied to App Staging inside transactions that were rolled
 * back; the resulting policy carried the block check while keeping every
 * existing share condition, both rewritten RPCs kept SECURITY DEFINER and
 * gained the check, and a follow-up query confirmed staging was left unchanged.
 *
 * KSB29-033 is NOT a defect and nothing is granted for it — see the bottom.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20260815140000_dressing_room_items_blocking.sql';

const sql = () => fs.readFileSync(path.join(MIGRATIONS, MIGRATION), 'utf8');

test('the blocking migration exists and reuses the authoritative relation', () => {
  assert.ok(
    fs.readdirSync(MIGRATIONS).includes(MIGRATION),
    'the Dressing Room item blocking migration must exist',
  );
  const body = sql();

  // The EXISTING helper, not a second notion of "blocked". Two block concepts
  // that could disagree would be worse than the gap being repaired.
  assert.match(body, /internal\.is_dressing_room_pair_blocked/);
  assert.doesNotMatch(
    body,
    /create (or replace )?function internal\.is_dressing_room_pair_blocked/i,
    'the block relation must be reused, never redefined',
  );
});

test('item reads require an unblocked relationship', () => {
  const body = sql();
  const policy = body.slice(
    body.indexOf('create policy "Recipients can select items via active shares"'),
    body.indexOf('comment on policy'),
  );

  assert.match(
    policy,
    /not internal\.is_dressing_room_pair_blocked\(dr\.user_id, \(select auth\.uid\(\)\)\)/,
    'the item policy must consult the block relation',
  );

  // The repair ADDS a condition; it must not have dropped any existing one, or
  // a revoked or expired share would start passing.
  for (const [label, pattern] of [
    ['membership', /m\.recipient_user_id = \(select auth\.uid\(\)\)/],
    ['not removed', /m\.removed_at is null/],
    ['active share', /s\.is_active = true/],
    ['not revoked', /s\.revoked_at is null/],
    ['not expired', /s\.expires_at is null or s\.expires_at > now\(\)/],
  ]) {
    assert.match(policy, pattern, `the ${label} condition must be preserved`);
  }
});

test('every SECURITY DEFINER helper checks the same block', () => {
  const body = sql();

  for (const fn of [
    'list_shared_rooms_for_me',
    'save_shared_room_for_me',
    'touch_shared_room_for_me',
  ]) {
    const start = body.indexOf(`create or replace function public.${fn}`);
    assert.ok(start >= 0, `${fn} must be rewritten by this migration`);
    const end = body.indexOf('$function$;', start);
    const definition = body.slice(start, end);

    assert.match(
      definition,
      /security definer/i,
      `${fn} must remain SECURITY DEFINER — this migration repairs it, not redesigns it`,
    );
    assert.match(
      definition,
      /not internal\.is_dressing_room_pair_blocked/,
      `${fn} bypasses the block contract without an explicit check`,
    );
    // search_path pinning is what stops a definer function resolving a shadowed
    // object; it must survive the rewrite.
    assert.match(definition, /set search_path to 'pg_catalog'/, `${fn} must keep its search_path`);
  }
});

test('a blocked relationship is indistinguishable from an unavailable share', () => {
  const body = sql();
  // Blocking must not become an oracle: the blocked user gets the SAME answer
  // as for a revoked or expired share, so they cannot infer that they were
  // specifically blocked.
  const save = body.slice(
    body.indexOf('create or replace function public.save_shared_room_for_me'),
    body.indexOf('create or replace function public.touch_shared_room_for_me'),
  );
  assert.match(save, /is_dressing_room_pair_blocked[\s\S]{0,200}'status', 'unavailable'/);
  assert.doesNotMatch(save, /'status', 'blocked'/, 'the status must not reveal a block');
  assert.doesNotMatch(body, /'blocked'/, 'no new status vocabulary may leak the block state');
});

test('no historical migration is edited and privileges are not broadened', () => {
  const body = sql();

  // The applied blocking migration stays untouched; this is a forward repair.
  const original = fs.readFileSync(
    path.join(MIGRATIONS, '20260806153233_dressing_room_user_blocking.sql'),
    'utf8',
  );
  assert.doesNotMatch(
    original,
    /dressing_room_items[\s\S]{0,400}Recipients can select items/,
    'the already-applied migration must not be edited',
  );

  // Execute rights are restated exactly, never widened.
  assert.match(body, /revoke all on function public\.list_shared_rooms_for_me\(\) from public, anon/);
  assert.match(body, /grant execute on function public\.list_shared_rooms_for_me\(\) to authenticated/);
  assert.doesNotMatch(body, /grant .* to (public|anon)\b/i, 'nothing may be granted to public/anon');

  // RLS is never disabled to make a policy easier to write.
  assert.doesNotMatch(body, /disable row level security/i);
});

test('KSB29-033: the reactions grant is verified as present, not blindly re-granted', () => {
  const body = sql();

  // The audit reported no effective GRANT on dressing_room_item_reactions.
  // Both environments already hold SELECT/INSERT/UPDATE/DELETE for
  // `authenticated` with RLS enabled, read live on 2026-08-15. Granting again
  // would broaden nothing and prove nothing; granting MORE would weaken the
  // boundary this wave exists to strengthen.
  assert.doesNotMatch(
    body,
    /grant[^;]*on\s+(?:table\s+)?public\.dressing_room_item_reactions/i,
    'no grant may be issued for a permission that is already correct',
  );
  assert.match(
    body,
    /KSB29-033: NOT A DEFECT/,
    'the finding must be recorded rather than silently dropped',
  );
});
