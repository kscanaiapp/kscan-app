// Build 34 integration closure — executable source contract for RISK-02.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260830131956_signature_style_server_authority.sql'),
  'utf8',
);
const store = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/_shared/signatureStyle/signatureStyleProfileStore.ts'),
  'utf8',
);
const columnAmbiguityFix = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260830140000_fix_recompute_signature_style_column_ambiguity.sql'),
  'utf8',
);

// ── READ THIS BEFORE THE K+ ASSERTIONS BELOW ──────────────────────────────
//
// The two files above are APPLIED HISTORY, and the assertions in this suite
// describe what they did at the time. They are not the current entitlement
// contract: Build 34 owner authority resolved SIGNATURE_STYLE_ENTITLEMENT=FREE,
// and 20260915214857_signature_style_free_entitlement.sql removed the K+
// requirement these two carried (and only that requirement).
//
// So where a test below asserts `if not public.has_active_k_plus() then`, it is
// pinning that a historical migration was not retro-edited -- never that
// Signature Style requires K+ today. The live contract lives in
// __tests__/build34EntitlementMatrix.test.js and
// __tests__/signatureStyleFreeEntitlement.test.js, and the closing section of
// this file keeps the two views from drifting apart.

test('forgery control: the former client-payload RPC has no authenticated execute grant', () => {
  assert.match(migration, /revoke all on function public\.upsert_style_dna_profile\(integer, text, jsonb\)\s+from public, anon, authenticated;/);
  assert.doesNotMatch(migration, /grant execute on function public\.upsert_style_dna_profile[\s\S]*?to authenticated/i);
});

test('derivation control (HISTORICAL): the public RPC has no arguments and derived actor, K+ status, and live Closet evidence server-side', () => {
  assert.match(migration, /create or replace function public\.recompute_signature_style\(\)/);
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(migration, /if not public\.has_active_k_plus\(\) then/);
  assert.match(migration, /from public\.user_closet_items[\s\S]*?user_id = v_user_id[\s\S]*?deleted_at is null/);
  assert.match(migration, /grant execute on function public\.recompute_signature_style\(\) to authenticated;/);
});

test('write control: the Edge Function can request recomputation but sends no profile payload, revision, or user id', () => {
  assert.match(store, /rpc\('recompute_signature_style', \{\}\)/);
  assert.doesNotMatch(store, /upsert_style_dna_profile/);
  assert.doesNotMatch(store, /p_profile_data|p_evidence_revision|p_user_id/);
  assert.doesNotMatch(store, /\.from\(/);
});

test('the deterministic profile is compact, aggregate-only, and bounded', () => {
  assert.match(migration, /limit 10/);
  assert.match(migration, /'evidenceCount'/);
  assert.match(migration, /'colorFrequency'/);
  assert.match(migration, /'materialFrequency'/);
  assert.doesNotMatch(migration, /storage paths/i);
});

test('a malformed persisted profile cannot bypass trusted recomputation', () => {
  assert.match(migration, /jsonb_typeof\(v_existing\.profile_data\) = 'object'/);
  assert.match(migration, /jsonb_typeof\(v_existing\.profile_data -> 'evidenceCount'\) = 'number'/);
  assert.match(migration, /jsonb_typeof\(v_existing\.profile_data -> 'materialFrequency'\) = 'array'/);
  assert.match(migration, /Rebuild it from Closet evidence below/);
});

// ── Live bug closure: PR #230 column-shadowing fix ─────────────────────────
//
// The base migration's function body was never testable at the source-shape
// level for the defect that actually reached staging: `RETURNS TABLE(user_id
// uuid, ...)` shadows every bare `user_id` reference in the function body as
// a PL/pgSQL variable, and Postgres's plpgsql default (`#variable_conflict
// error`) refuses to resolve the ambiguity — not only in RETURNING/ON
// CONFLICT, as the earlier upsert_style_dna_profile fix assumed, but in an
// ordinary `where user_id = v_user_id` clause too, which this function hits
// before it ever reaches an INSERT. This was only caught by actually calling
// the RPC live on staging. These assertions close the gap so the same class
// cannot regress silently again.

test('live bug closure: the follow-up migration applies the same column-shadowing pragma', () => {
  assert.match(columnAmbiguityFix, /create or replace function public\.recompute_signature_style\(\)/);
  assert.match(columnAmbiguityFix, /as \$\$\n#variable_conflict use_column\ndeclare/);
});

test('live bug closure: every bare user_id reference in the fixed function is still present and still qualified as a plain column comparison', () => {
  // Not a rewrite -- the fix is the pragma alone. Confirms the fix migration
  // did not also silently change the query shape while adding the pragma.
  // Scoped to the function body (after the opening `as $$`) so the header
  // comment's own illustrative "where user_id = v_user_id" line, quoting the
  // original staging error, is not counted as a ninth live occurrence.
  const functionBody = columnAmbiguityFix.split('as $$')[1];
  // 8 occurrences: the evidence-count query, the existing-row lookup, and one
  // per source column feeding each of the 5 signature_style_frequency calls,
  // plus the color-frequency subquery's UNION ALL half.
  const bareUserIdRefs = (functionBody.match(/\buser_id\s*=\s*v_user_id\b/g) || []).length;
  assert.equal(bareUserIdRefs, 8, 'expected exactly the 8 bare user_id = v_user_id comparisons this function body has');
  assert.match(columnAmbiguityFix, /on conflict \(user_id\) do update/);
});

test('live bug closure (HISTORICAL): the fix migration kept the same K+ gate, zero-argument signature, and grants as the base migration', () => {
  assert.match(columnAmbiguityFix, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(columnAmbiguityFix, /if not public\.has_active_k_plus\(\) then/);
  assert.match(columnAmbiguityFix, /revoke all on function public\.recompute_signature_style\(\) from public, anon;/);
  assert.match(columnAmbiguityFix, /grant execute on function public\.recompute_signature_style\(\) to authenticated;/);
});

// ── Current entitlement authority: SIGNATURE_STYLE = FREE ─────────────────
//
// The historical assertions above are satisfied by files that are never
// re-run against a database that already applied them. What governs behaviour
// is the LAST definition in the migration tree, so this closing section pins
// that the forward-only repair exists, supersedes both files above, and
// carried every non-entitlement control forward unchanged.

const freeEntitlementRepair = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260915214857_signature_style_free_entitlement.sql'),
  'utf8',
);

test('entitlement authority: the forward-only repair supersedes both historical definitions', () => {
  const dir = path.join(ROOT, 'supabase/migrations');
  const defining = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) =>
      /create or replace function public\.recompute_signature_style\s*\(/i.test(
        fs.readFileSync(path.join(dir, name), 'utf8'),
      ),
    );
  assert.deepEqual(defining, [
    '20260830131956_signature_style_server_authority.sql',
    '20260830140000_fix_recompute_signature_style_column_ambiguity.sql',
    '20260915214857_signature_style_free_entitlement.sql',
    '20260915232402_signature_style_free_closet_evidence.sql',
  ]);
});

test('entitlement authority (STEP 1): the entitlement repair removed ONLY the K+ requirement', () => {
  // Executable SQL only -- the migration explains in prose which gate it
  // removed, and that explanation must not read as the gate.
  const executable = freeEntitlementRepair
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  assert.doesNotMatch(executable, /has_active_k_plus/);
  assert.doesNotMatch(executable, /errcode = '42501'/);
  // Everything else the two historical files established is still here.
  assert.match(freeEntitlementRepair, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(freeEntitlementRepair, /raise exception 'not authenticated' using errcode = '28000'/);
  assert.match(freeEntitlementRepair, /as \$\$\n#variable_conflict use_column\ndeclare/);
  assert.match(freeEntitlementRepair, /security definer/);
  assert.match(freeEntitlementRepair, /set search_path = ''/);
  assert.match(freeEntitlementRepair, /jsonb_typeof\(v_existing\.profile_data\) = 'object'/);
  assert.match(freeEntitlementRepair, /Rebuild it from Closet evidence below/);
  assert.match(freeEntitlementRepair, /limit 10|signature_style_frequency/);
  assert.match(freeEntitlementRepair, /revoke all on function public\.recompute_signature_style\(\) from public, anon;/);
  assert.match(freeEntitlementRepair, /grant execute on function public\.recompute_signature_style\(\) to authenticated;/);
  const body = freeEntitlementRepair.split('as $$')[1];
  assert.equal([...body.matchAll(/\buser_id\s*=\s*v_user_id\b/g)].length, 8);
});

// STEP 2 superseded STEP 1's evidence source. The live contract -- both owned-item
// sources under one entitlement-independent algorithm -- is pinned in
// __tests__/signatureStyleFreeClosetEvidence.test.js; this only records that the
// entitlement repair above is history and was not retro-edited when it was
// superseded.
test('entitlement authority (STEP 2): the free-Closet evidence repair supersedes it, and step 1 was not retro-edited', () => {
  const evidenceRepair = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260915232402_signature_style_free_closet_evidence.sql'),
    'utf8',
  );
  const executable = evidenceRepair
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  assert.match(executable, /from public\.wardrobe_utility_items/);
  assert.match(executable, /from public\.user_closet_items/);
  assert.doesNotMatch(executable, /has_active_k_plus/);
  // Step 1 still reads only the K+ store: it is applied history, not the contract.
  const step1 = freeEntitlementRepair
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  assert.doesNotMatch(step1, /wardrobe_utility_items/);
});

test('entitlement authority: the historical files were not retro-edited to match', () => {
  // A forward-only repair, not a rewrite of applied history.
  assert.match(migration, /if not public\.has_active_k_plus\(\) then/);
  assert.match(columnAmbiguityFix, /if not public\.has_active_k_plus\(\) then/);
});
