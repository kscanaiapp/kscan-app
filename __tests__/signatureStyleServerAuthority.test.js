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
