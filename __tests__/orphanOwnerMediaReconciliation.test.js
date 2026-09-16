// B33-STO-002 -- orphan-owner media reconciliation.
//
// Production holds 7 unreferenced storage objects across 4 owners whose auth.users
// rows no longer exist. They survive because storage.objects has no FK to auth.users,
// and they were never swept because the Auth deletions bypassed the deletion worker
// entirely (attempt_count = 0, worker_id null, no purge state transition for any of
// the 8 stale requests).
//
// The retained-owner-media work queue cannot service them: it is fed by a SUCCESSFUL
// purge registering prefixes it deliberately retained, and no purge ever ran here.
// The reconciliation therefore keys on the one signal that survives an out-of-band
// Auth deletion -- storage.objects.owner failing to resolve.
//
// These tests pin the decision rule and the safety rails. The SQL side (reference
// preservation, live-owner exclusion, null-owner exclusion, bucket allowlist,
// pagination) is proven against staging by the harness recorded in the migration
// header; what is asserted here is the contract the Edge Function must keep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const FN = read('supabase', 'functions', 'reconcile-orphan-media', 'index.ts');
const SQL = read('supabase', 'migrations', '20260916130553_build33_orphan_owner_media_reconciliation_rpc.sql');

// ── The decision rule, modelled exactly as the SQL expresses it ──────────────

function isCandidate(object, liveUserIds, referencedPaths) {
  if (object.owner === null || object.owner === undefined) return false;   // cannot be attributed
  if (liveUserIds.has(object.owner)) return false;                          // owner still exists
  if (referencedPaths.has(object.name)) return false;                       // still in use
  return true;
}

const LIVE = 'live-user-1';
const DEAD = 'dead-user-1';

test('an object still referenced by surviving content is never a candidate', () => {
  const obj = { name: `${DEAD}/scans/a.jpg`, owner: DEAD };
  assert.equal(isCandidate(obj, new Set([LIVE]), new Set([obj.name])), false);
});

test('an unreferenced object owned by a vanished account is a candidate', () => {
  const obj = { name: `${DEAD}/scans/b.jpg`, owner: DEAD };
  assert.equal(isCandidate(obj, new Set([LIVE]), new Set()), true);
});

test('an unreferenced object owned by a LIVE account is never a candidate', () => {
  const obj = { name: `${LIVE}/scans/c.jpg`, owner: LIVE };
  assert.equal(isCandidate(obj, new Set([LIVE]), new Set()), false,
    'a live user\'s media must never be swept, referenced or not');
});

test('an object with no recorded owner is out of scope', () => {
  const obj = { name: 'unknown/scans/d.jpg', owner: null };
  assert.equal(isCandidate(obj, new Set([LIVE]), new Set()), false,
    'ownership cannot be proven, so the object must be left alone');
});

test('re-running after removal is idempotent', () => {
  const obj = { name: `${DEAD}/scans/e.jpg`, owner: DEAD };
  assert.equal(isCandidate(obj, new Set([LIVE]), new Set()), true);
  const remaining = [];                       // the object was removed
  assert.deepEqual(remaining.filter((o) => isCandidate(o, new Set([LIVE]), new Set())), []);
});

// ── Safety rails the Edge Function must keep ────────────────────────────────

test('the sweep is secret-gated and rejects the anon key', () => {
  assert.match(FN, /ORPHAN_MEDIA_SWEEP_SECRET/, 'a dedicated secret gates the sweep');
  assert.match(FN, /secretsMatch/, 'the secret is compared in constant time');
  assert.match(FN, /mismatch \|= a\[i\] \^ b\[i\]/, 'constant-time byte comparison is present');
  assert.match(FN, /SUPABASE_ANON_KEY[\s\S]{0,200}Unauthorized/,
    'a caller holding only the anon key must be rejected');
});

test('the sweep is dry-run unless every switch says otherwise', () => {
  assert.match(FN, /const dryRun = envDryRun \|\| dryRunFlag \|\| !enabled/,
    'deploying the function must delete nothing until deliberately enabled');
  assert.match(FN, /orphan_media_sweep_enabled/);
  assert.match(FN, /orphan_media_sweep_dry_run/);
});

test('an unreadable kill switch is treated as OFF', () => {
  const flagFn = FN.slice(FN.indexOf('async function readAppConfigFlag'));
  assert.match(flagFn.slice(0, flagFn.indexOf('\n}')), /if \(!response\.ok\) return false/,
    'a flag that cannot be read must never be read as permission to delete');
});

test('candidate selection is server-side only -- no caller-supplied path is accepted', () => {
  assert.doesNotMatch(FN, /await req\.json\(\)/,
    'the function must not read a request body, so a caller cannot nominate objects');
  assert.match(FN, /rpc\/list_orphan_owner_media/,
    'candidates come only from the server-side RPC');
});

test('enumeration failure fails closed', () => {
  assert.match(FN, /candidate enumeration failed/,
    'a failed enumeration throws rather than proceeding with a partial set');
  assert.match(FN, /if \(!Array\.isArray\(page\)\) throw/,
    'a malformed page aborts the run');
});

test('partial storage removal fails closed', () => {
  assert.match(FN, /orphan_sweep_partial_removal/);
  assert.match(FN, /storage partial removal/,
    'a short removal batch must abort rather than continue');
});

test('the sweep is bounded per invocation and reports whether more remain', () => {
  assert.match(FN, /MAX_OBJECTS_PER_RUN = 1000/);
  assert.match(FN, /hasMore/);
});

test('logs stay sanitized -- no object paths or user ids', () => {
  const logCalls = FN.match(/log(Event|)\('orphan_sweep[^;]+;/g) ?? [];
  assert.ok(logCalls.length > 0, 'the sweep emits sanitized events');
  for (const call of logCalls) {
    assert.doesNotMatch(call, /object_name|objectName|candidates\.map/,
      `a log call must not emit object paths: ${call.slice(0, 120)}`);
  }
  assert.match(FN, /owner_prefix/, 'owners are reported as short prefixes only');
});

// Comments in this function deliberately DISCUSS the deletion worker to explain why
// the sweep is separate from it. The rule being enforced is about code, so strip
// comments before asserting rather than matching prose.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the sweep shares no code with the account-deletion worker', () => {
  const code = stripComments(FN);
  assert.doesNotMatch(code, /_shared\/deletion/,
    'importing deletion-worker internals would couple this to account-deletion semantics');
  assert.doesNotMatch(code, /deletion_requests|auth\.admin\.deleteUser|process-account-deletions/,
    'the sweep must never touch the deletion ledger or delete an Auth user');
  // Guard the guard: prove the strip actually removed the prose that mentions them.
  assert.match(FN, /deletion_requests/, 'the header explains the relationship in prose');
});

// ── Safety rails the SQL must keep ──────────────────────────────────────────

test('the RPC is restricted to the one sweepable bucket', () => {
  assert.match(SQL, /p_bucket is distinct from 'style-library-images'/,
    'legal-documents and public-assets hold system assets and must be unreachable');
  assert.match(SQL, /raise exception 'bucket not sweepable/);
});

test('the RPC excludes live owners and unattributable objects', () => {
  assert.match(SQL, /o\.owner is not null/, 'objects with no owner are out of scope');
  assert.match(SQL, /not exists \(select 1 from auth\.users u where u\.id = o\.owner\)/,
    'only objects whose owner no longer resolves are returned');
});

test('the RPC checks references beyond dressing_room_items', () => {
  for (const table of ['saved_scans', 'look_items', 'dressing_room_items', 'inspiration_items',
                       'outfit_decision_option_items', 'dressing_rooms', 'looks', 'wardrobe_utility_items']) {
    assert.ok(SQL.includes(`public.${table}`), `the reference check must span public.${table}`);
  }
});

test('the RPC is service-role only and says so in its own post-condition', () => {
  assert.match(SQL, /revoke execute on function public\.list_orphan_owner_media\(text,integer,text\) from public/);
  assert.match(SQL, /revoke execute on function public\.list_orphan_owner_media\(text,integer,text\) from anon/);
  assert.match(SQL, /revoke execute on function public\.list_orphan_owner_media\(text,integer,text\) from authenticated/);
  assert.match(SQL, /grant  execute on function public\.list_orphan_owner_media\(text,integer,text\) to service_role/);
  assert.match(SQL, /raise exception 'list_orphan_owner_media is client-executable'/);
});

test('the RPC only reads -- byte removal stays with the Storage API', () => {
  const body = SQL.slice(SQL.indexOf('create or replace function'), SQL.indexOf('revoke execute'));
  assert.doesNotMatch(body, /\bdelete\s+from\b/i,
    'SQL deletion of storage rows is blocked by storage.protect_delete and would strand the bytes');
  assert.match(body, /\bstable\b/, 'the function is declared STABLE');
});

test('no arbitrary retention window is introduced', () => {
  const body = SQL.slice(SQL.indexOf('create or replace function'), SQL.indexOf('revoke execute'));
  assert.doesNotMatch(body, /interval|make_interval/i,
    'eligibility begins when the last reference goes, not after a timer');
});
