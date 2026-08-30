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
  path.join(ROOT, 'supabase/functions/_shared/styleDna/styleDnaProfileStore.ts'),
  'utf8',
);
const columnAmbiguityFix = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260830140000_fix_recompute_signature_style_column_ambiguity.sql'),
  'utf8',
);

test('forgery control: the former client-payload RPC has no authenticated execute grant', () => {
  assert.match(migration, /revoke all on function public\.upsert_style_dna_profile\(integer, text, jsonb\)\s+from public, anon, authenticated;/);
  assert.doesNotMatch(migration, /grant execute on function public\.upsert_style_dna_profile[\s\S]*?to authenticated/i);
});

test('derivation control: the public RPC has no arguments and derives actor, K+ status, and live Closet evidence server-side', () => {
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

test('live bug closure: the fix migration keeps the same K+ gate, zero-argument signature, and grants as the base migration', () => {
  assert.match(columnAmbiguityFix, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(columnAmbiguityFix, /if not public\.has_active_k_plus\(\) then/);
  assert.match(columnAmbiguityFix, /revoke all on function public\.recompute_signature_style\(\) from public, anon;/);
  assert.match(columnAmbiguityFix, /grant execute on function public\.recompute_signature_style\(\) to authenticated;/);
});
