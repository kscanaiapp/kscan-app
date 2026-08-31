// INT-KPLUS-010 — deleted-owner media referenced by a shared room.
//
// Account purge deliberately RETAINS storage objects that a surviving
// dressing_room_items row still points at: item rows cascade with their ROOM,
// not with the deleting user, so a room transferred to another owner keeps its
// images. That retention is correct.
//
// The defect was the other end of the lifecycle: nothing ever revisited a
// retained object once the last surviving reference disappeared, so a deleted
// owner's media outlived every reference to it, permanently.
//
// Owner-approved policy (2026-08-31): retain while referenced; eligible for
// deletion the moment the final reference is gone; reuse the existing reference
// check; never trust client-side room teardown; no indefinite retention; no
// additional arbitrary retention window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const WORKER = read('supabase', 'functions', 'process-account-deletions', 'index.ts');
const SQL = read('supabase', 'migrations', '20260831140000_deleted_owner_retained_media.sql');

// ── The lifecycle, simulated against the real sweep semantics ───────────────
//
// The sweep's decision rule is exactly: orphaned = listed paths MINUS paths
// still referenced by a surviving dressing_room_items row. Model that rule and
// drive the full lifecycle through it.

function sweepDecision(listedPaths, referencedPaths) {
  const referenced = new Set(referencedPaths);
  const orphaned = listedPaths.filter((p) => !referenced.has(p));
  return { orphaned, remaining: listedPaths.length - orphaned.length };
}

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OBJECT = `${OWNER}/rooms/look-1.jpg`;

test('LIFECYCLE: delete owner -> room retains object -> final reference torn down -> object removed', () => {
  // 1. Owner purged. A surviving transferred room still references the object,
  //    so the purge retains it. Deleting it here would break the new owner.
  let listed = [OBJECT];
  let referenced = [OBJECT];
  let decision = sweepDecision(listed, referenced);
  assert.deepEqual(decision.orphaned, [], 'a referenced object must NOT be deleted');
  assert.equal(decision.remaining, 1);

  // 2. A later sweep, reference still present: still retained. Repeated sweeps
  //    must be idempotent and must not erode a live reference.
  decision = sweepDecision(listed, referenced);
  assert.deepEqual(decision.orphaned, [], 'retention must be stable across sweeps');

  // 3. The final room reference is torn down.
  referenced = [];

  // 4. The next sweep removes the now-orphaned object.
  decision = sweepDecision(listed, referenced);
  assert.deepEqual(decision.orphaned, [OBJECT], 'an unreferenced object must be removed');
  assert.equal(decision.remaining, 0, 'the prefix is now clear');

  // 5. Nothing left: the work item is settled with 0 remaining and deleted.
  listed = [];
  decision = sweepDecision(listed, []);
  assert.deepEqual(decision.orphaned, []);
  assert.equal(decision.remaining, 0);
});

test('an object referenced by a DIFFERENT surviving item is still retained', () => {
  const other = `${OWNER}/rooms/look-2.jpg`;
  const decision = sweepDecision([OBJECT, other], [other]);
  assert.deepEqual(decision.orphaned, [OBJECT]);
  assert.equal(decision.remaining, 1, 'the still-referenced sibling survives');
});

// ── Policy encoded in the repair ────────────────────────────────────────────

test('no additional retention window is introduced', () => {
  // Eligibility begins when the last reference goes, not after a timer. A
  // grace/TTL/age predicate here would be an unapproved retention policy.
  const claim = SQL.slice(SQL.indexOf('claim_retained_owner_media_for_sweep'));
  const claimBody = claim.slice(0, claim.indexOf('$$;'));
  assert.doesNotMatch(claimBody, /interval|make_interval|now\(\)\s*-/i,
    'the sweep must not withhold eligibility for an arbitrary period');
  assert.match(claimBody, /where cleared_at is null/);
});

test('indefinite retention is NOT adopted: a cleared prefix is actually removed', () => {
  const settle = SQL.slice(SQL.indexOf('function public.settle_retained_owner_media'));
  assert.match(settle, /if coalesce\(p_remaining, 0\) <= 0 then/);
  assert.match(settle, /delete from public\.deleted_owner_retained_media/);
});

test('the sweep reuses the EXISTING reference check, not a reimplementation', () => {
  const sweep = WORKER.slice(
    WORKER.indexOf('async function sweepOrphanedOwnerMedia'),
    WORKER.indexOf('async function deleteOwnedStorage'),
  );
  assert.match(sweep, /await collectReferencedStoragePaths\(supabase, prefix\)/);
  assert.match(sweep, /await listPrefixPaths\(bucket, prefix\)/);
  // Exactly one definition of the reference check exists in the file.
  const definitions = WORKER.match(/async function collectReferencedStoragePaths\(/g) ?? [];
  assert.equal(definitions.length, 1, 'the reference check must not be duplicated');
});

test('the sweep FAILS CLOSED: an undeterminable reference set deletes nothing', () => {
  const sweep = WORKER.slice(
    WORKER.indexOf('async function sweepOrphanedOwnerMedia'),
    WORKER.indexOf('async function deleteOwnedStorage'),
  );
  assert.match(sweep, /\} catch \(error\) \{/);
  assert.match(sweep, /summary\.skipped \+= 1;/);
  // collectReferencedStoragePaths throws on error, and that throw must land in
  // the per-prefix catch rather than proceeding to a removal.
  const removeIdx = sweep.indexOf('await bucket.remove(orphaned)');
  const refIdx = sweep.indexOf('await collectReferencedStoragePaths');
  assert.ok(refIdx > 0 && refIdx < removeIdx, 'the reference check must precede any removal');
  assert.match(
    WORKER,
    /throw new Error\(`reference check failed for \$\{prefix\}/,
    'the reference check must still fail closed',
  );
});

test('a dry run deletes nothing and settles nothing', () => {
  const sweep = WORKER.slice(
    WORKER.indexOf('async function sweepOrphanedOwnerMedia'),
    WORKER.indexOf('async function deleteOwnedStorage'),
  );
  assert.match(sweep, /if \(orphaned\.length > 0 && !options\.dryRun\)/);
  assert.match(sweep, /if \(!options\.dryRun\) \{\s*await rpc\('settle_retained_owner_media'/);
  assert.match(WORKER, /sweepOrphanedOwnerMedia\(supabase, \{ dryRun: true \}\)/);
});

test('the live sweep runs only on the live path and cannot fail a purge', () => {
  assert.match(WORKER, /sweepOrphanedOwnerMedia\(supabase, \{ dryRun: false \}\)/);
  const liveIdx = WORKER.indexOf("sweepOrphanedOwnerMedia(supabase, { dryRun: false })");
  const dryReturnIdx = WORKER.indexOf("mode: 'dry_run'");
  assert.ok(liveIdx > dryReturnIdx, 'the live sweep must sit after the dry-run early return');
  // Wrapped so a sweep failure never turns a successful purge run into a failure.
  const region = WORKER.slice(liveIdx - 400, liveIdx + 500);
  assert.match(region, /try \{/);
  assert.match(region, /orphan_sweep_failed/);
});

// ── Authority and privacy ───────────────────────────────────────────────────

test('client-side teardown is never the deletion authority', () => {
  // The sweep is driven by the worker's own claim RPC, not by anything a client
  // sends. No client-supplied identifier reaches it.
  const sweep = WORKER.slice(
    WORKER.indexOf('async function sweepOrphanedOwnerMedia'),
    WORKER.indexOf('async function deleteOwnedStorage'),
  );
  assert.match(sweep, /rpc\('claim_retained_owner_media_for_sweep'/);
  assert.doesNotMatch(sweep, /req\.|body\./, 'no request input may steer the sweep');
});

test('every new RPC is service_role only', () => {
  for (const fn of [
    'record_retained_owner_media',
    'claim_retained_owner_media_for_sweep',
    'settle_retained_owner_media',
  ]) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${fn}`), `${fn} revoke`);
    assert.match(SQL, new RegExp(`grant execute on function public\\.${fn}[^;]*to service_role;`), `${fn} grant`);
  }
});

test('the work list has RLS on and no client grants', () => {
  assert.match(SQL, /alter table public\.deleted_owner_retained_media enable row level security;/);
  assert.match(
    SQL,
    /revoke all on table public\.deleted_owner_retained_media from public, anon, authenticated;/,
  );
  assert.doesNotMatch(SQL, /grant [a-z, ]* on table public\.deleted_owner_retained_media to authenticated/);
});

test('the sweep never logs the raw prefix (it embeds a purged account id)', () => {
  const sweep = WORKER.slice(
    WORKER.indexOf('async function sweepOrphanedOwnerMedia'),
    WORKER.indexOf('async function deleteOwnedStorage'),
  );
  const logCalls = sweep.match(/logEvent\([^)]*\{[\s\S]*?\}\)/g) ?? [];
  for (const call of logCalls) {
    assert.doesNotMatch(call, /prefix,/, 'the raw prefix must not be logged');
    assert.doesNotMatch(call, /prefix:\s*prefix/, 'the raw prefix must not be logged');
  }
});

// ── The purge side still behaves ────────────────────────────────────────────

test('purge still RETAINS referenced objects (the invariant that must not regress)', () => {
  assert.match(WORKER, /const removable = paths\.filter\(\(p\) => !referenced\.has\(p\)\);/);
  assert.match(WORKER, /const retained = paths\.length - removable\.length;/);
});

test('purge registers the retained prefix so the sweep can find it later', () => {
  assert.match(WORKER, /rpc\('record_retained_owner_media'/);
  assert.match(WORKER, /p_retained: retainedCount/);
  // Registration is best-effort: it must never fail an already-successful purge.
  const idx = WORKER.indexOf("rpc('record_retained_owner_media'");
  const region = WORKER.slice(idx - 500, idx + 500);
  assert.match(region, /try \{/);
  assert.match(region, /retained_media_registration_failed/);
});

test('registering zero retained objects clears any stale work item', () => {
  const record = SQL.slice(SQL.indexOf('function public.record_retained_owner_media'));
  assert.match(record, /if coalesce\(p_retained, 0\) <= 0 then/);
  assert.match(record, /delete from public\.deleted_owner_retained_media/);
});

test('no new Edge Function is introduced (the governed set is unchanged)', () => {
  const dirs = fs
    .readdirSync(path.join(ROOT, 'supabase', 'functions'))
    .filter((n) => !n.startsWith('_'))
    .filter((n) => fs.statSync(path.join(ROOT, 'supabase', 'functions', n)).isDirectory());
  // 21 since Build 34 K4 VTO backend convergence added vto-generate as its own
  // governed function (tryon-clothes-pro was already governed as the retired
  // stub). That is a legitimate, separately-governed addition, not this
  // sweep growing a function of its own -- which the directory-inclusion
  // check below still proves.
  assert.equal(dirs.length, 21, 'the sweep must live in the existing worker, not a new function');
  assert.ok(dirs.includes('process-account-deletions'));
});
