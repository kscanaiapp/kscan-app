/**
 * FREE_CLOSET_TO_SIGNATURE_STYLE — the evidence aggregation contract.
 *
 * Owner authority (Build 34): SIGNATURE_STYLE_ENTITLEMENT=FREE and
 * FREE_CLOSET_TO_SIGNATURE_STYLE=REQUIRED. Removing the K+ entitlement gate
 * (20260915214857) let a free user CALL the RPC; it did not give them anything
 * to compute from, because this build ships two owned-item stores and the
 * function read only the K+ one:
 *
 *   public.wardrobe_utility_items   FREE  (RLS `user_id = auth.uid()`)
 *   public.user_closet_items        K+    (RLS + has_active_k_plus())
 *
 * Proven live on staging before the repair: a never-K+ actor with a real item
 * in their free Closet got evidenceCount 0.
 *
 * WHAT THIS FILE GUARDS
 *
 * The architecture, not just the outcome. The dangerous regression here is not
 * "the union disappears" — it is someone re-introducing an entitlement branch
 * into SOURCE SELECTION, or fabricating a garment type to fill a frequency
 * bucket, or reaching for fuzzy matching to dedupe across stores. Each of those
 * has its own test below.
 *
 * The runtime journeys these encode were exercised against live staging; see
 * the PR for the recorded results.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const FN = 'recompute_signature_style';

/** The LAST migration that defines the function is the one that governs. */
function authoritative() {
  const defining = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .filter((n) =>
      new RegExp(`create or replace function public\\.${FN}\\s*\\(`, 'i').test(
        fs.readFileSync(path.join(MIGRATIONS_DIR, n), 'utf8'),
      ),
    );
  assert.ok(defining.length > 0, `no migration defines public.${FN}`);
  const file = defining[defining.length - 1];
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const start = sql.search(new RegExp(`create or replace function public\\.${FN}\\s*\\(`, 'i'));
  const definition = sql.slice(start);
  // Comments explain; they do not execute. Architecture claims are checked
  // against executable SQL so prose can never satisfy them.
  const executable = definition
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  return { file, sql, definition, executable };
}

test('both owned-item sources feed one evidence set', () => {
  const { executable } = authoritative();
  assert.match(executable, /from public\.user_closet_items/,
    'the existing owned-item source must still be read');
  assert.match(executable, /from public\.wardrobe_utility_items/,
    'FREE_CLOSET_TO_SIGNATURE_STYLE=REQUIRED — the free Closet must be read');
  // They are UNIONed into a single set, not computed as rival profiles.
  assert.match(executable, /union all/i);
});

test('SOURCE SELECTION IS NOT ENTITLEMENT-DEPENDENT', () => {
  // The forbidden shape is `if K+ then source A else source B`. A K+ actor with
  // rows in both stores must get ONE coherent profile from ONE algorithm, not a
  // different algorithm from a free actor's.
  const { executable } = authoritative();
  for (const forbidden of [
    /has_active_k_plus/,
    /kplus_has_active_entitlement/,
    /get_my_kplus_entitlement_summary/,
    /user_entitlements/,
    /kplus_/,
  ]) {
    assert.doesNotMatch(
      executable,
      forbidden,
      'entitlement state must not influence which evidence sources are read',
    );
  }
  // And no conditional is wrapped around either source read.
  const closetAt = executable.indexOf('from public.user_closet_items');
  const freeAt = executable.indexOf('from public.wardrobe_utility_items');
  assert.ok(closetAt > 0 && freeAt > 0);
  const between = executable.slice(Math.min(closetAt, freeAt), Math.max(closetAt, freeAt));
  assert.doesNotMatch(between, /\bif\b[\s\S]{0,200}\bthen\b/,
    'no branch may sit between the two evidence sources');
});

test('GARMENT TYPE IS OMITTED FOR ROWS THAT CARRY NONE — never inferred', () => {
  const { executable, sql } = authoritative();
  // wardrobe_utility_items has no clothing_type. The free branch must supply an
  // explicit NULL garment type rather than substituting a different attribute.
  assert.match(executable, /null::text\s+as garment_type/,
    'free-Closet rows must contribute NO garment type');
  // silhouette is a DIFFERENT attribute (a cut), not a garment type. It must
  // not be read into the garment-type position.
  const freeStart = executable.indexOf('from public.wardrobe_utility_items');
  assert.ok(freeStart > 0);
  assert.doesNotMatch(
    executable,
    /silhouette[^\n]*as garment_type|garment_type[^\n]*silhouette/,
    'silhouette must never be substituted for a garment type',
  );
  // The reasoning is recorded, so a later reader does not "fix" the empty bucket.
  assert.match(sql, /OMIT_FOR_THAT_ROW/);
});

test('the free Closet still contributes every attribute it authoritatively carries', () => {
  const { executable } = authoritative();
  const freeStart = executable.indexOf('from public.wardrobe_utility_items');
  const freeBlock = executable.slice(Math.max(0, freeStart - 2000), freeStart + 2000);
  for (const attribute of ['category', 'brand', 'color', 'material']) {
    assert.match(
      freeBlock,
      new RegExp(`f\\.${attribute}|w\\.${attribute}`),
      `the free Closet's ${attribute} must reach the aggregate`,
    );
  }
});

test('DEDUPLICATION uses exact existing identities and never fuzzy matching', () => {
  const { executable, sql } = authoritative();
  // Collapse on the free store's own upsert identity, with its NOT NULL fallback.
  assert.match(executable, /distinct on \(coalesce\(nullif\(btrim\(coalesce\(w\.client_id, ''\)\), ''\), w\.source_item_id\)\)/);
  // Deterministic pick: most recent, then a stable tie-break that cannot depend
  // on scan order.
  assert.match(executable, /order by[\s\S]{0,200}w\.updated_at desc,\s*\n?\s*w\.id/);
  // No fuzzy/similarity matching during freeze.
  for (const forbidden of [/similarity\s*\(/i, /levenshtein/i, /soundex/i, /pg_trgm/i, /%\s*>/]) {
    assert.doesNotMatch(executable, forbidden, 'fuzzy matching must not be introduced');
  }
  // The cross-store limitation is documented rather than silently papered over.
  assert.match(sql, /DOCUMENTED LIMITATION/);
  assert.match(sql, /no safe cross-table equivalence key/i);
});

test('EVIDENCE_REVISION fingerprints the normalized evidence actually used', () => {
  const { executable, sql } = authoritative();
  // A content hash over the canonical per-row text, ordered BY THAT TEXT — so
  // it cannot depend on table iteration order.
  assert.match(executable, /md5\(coalesce\(string_agg\(k\.line, E'\\n' order by k\.line\), ''\)\)/);
  // Multi-valued attributes are sorted inside the row text for the same reason.
  assert.match(executable, /string_agg\(btrim\(v\), ',' order by lower\(btrim\(v\)\)/);
  // Versioned, so every profile stored under the single-source algorithm is
  // rebuilt instead of being reused with stale contents.
  assert.match(executable, /'v2:' \|\| v_fingerprint/);
  // The empty case keeps its existing behaviour exactly.
  assert.match(executable, /when coalesce\(v_count, 0\) = 0 then 'empty:0'/);
  assert.match(sql, /'v2:' prefix is load-bearing/);
});

test('removing the entitlement gate did not remove the authorization boundary', () => {
  const { executable } = authoritative();
  assert.match(executable, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(executable, /raise exception 'not authenticated' using errcode = '28000'/);
  assert.match(executable, /security definer/);
  assert.match(executable, /set search_path = ''/);
  assert.match(executable, /#variable_conflict use_column/);
  assert.match(executable, /create or replace function public\.recompute_signature_style\(\)/);
  assert.doesNotMatch(executable, /create or replace function public\.recompute_signature_style\(\s*p_/);
  assert.match(executable, /revoke all on function public\.recompute_signature_style\(\) from public, anon;/);
  assert.match(executable, /grant execute on function public\.recompute_signature_style\(\) to authenticated;/);
});

test('CROSS-USER: every evidence read is scoped to auth.uid(), so one actor cannot aggregate another', () => {
  const { executable } = authoritative();
  const reads = [...executable.matchAll(/from public\.(\w+)/g)];
  assert.ok(reads.length >= 3);
  for (let i = 0; i < reads.length; i += 1) {
    const start = reads[i].index;
    const end = i + 1 < reads.length ? reads[i + 1].index : executable.length;
    assert.match(
      executable.slice(start, end),
      /user_id = v_user_id/,
      `public.${reads[i][1]} is read without an owner scope`,
    );
  }
  // Identity is derived, never accepted.
  assert.doesNotMatch(executable, /p_user_id|p_owner_id/);
});

test('the bounded aggregate contract is unchanged: counts only, no identifiers', () => {
  const { executable } = authoritative();
  for (const dimension of [
    'evidenceCount',
    'colorFrequency',
    'categoryFrequency',
    'garmentTypeFrequency',
    'brandFrequency',
    'materialFrequency',
  ]) {
    assert.match(executable, new RegExp(`'${dimension}'`));
  }
  // The top-N bound still comes from the shared helper, not re-implemented.
  assert.equal(
    [...executable.matchAll(/public\.signature_style_frequency\(/g)].length,
    5,
    'all five frequency dimensions must go through the bounded helper',
  );
  // No item identifier, storage path or note may reach profile_data.
  const buildAt = executable.indexOf('jsonb_build_object');
  const build = executable.slice(buildAt, executable.indexOf('insert into public.user_style_profiles'));
  for (const leak of [/ident/, /client_id/, /source_item_id/, /storage_path/, /notes/, /image_uri/, /title/]) {
    assert.doesNotMatch(build, leak, 'profile_data must stay an aggregate summary');
  }
});

test('Closet entitlement boundaries are untouched by this repair', () => {
  const { executable } = authoritative();
  // This function changes what an actor's OWN profile is derived from. It must
  // not redefine has_active_k_plus, touch RLS, or alter any table.
  for (const forbidden of [
    /create or replace function public\.has_active_k_plus/i,
    /create policy/i,
    /drop policy/i,
    /alter table/i,
    /disable row level security/i,
    /grant [^;]*on table/i,
  ]) {
    assert.doesNotMatch(executable, forbidden);
  }
  assert.equal([...executable.matchAll(/create or replace function/gi)].length, 1);
  // The free Closet's own RLS is what makes it free, and it is not edited here.
  const freeTable = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '20260704175544_free_tier_utility_tables.sql'), 'utf8');
  assert.match(freeTable, /create policy "Users can select own wardrobe utility items"[\s\S]*?using \(user_id = auth\.uid\(\)\)/);
  assert.doesNotMatch(
    freeTable.slice(freeTable.indexOf('wardrobe_utility_items'), freeTable.indexOf('wardrobe_collections')),
    /has_active_k_plus/,
    'the free Closet must not become K+ gated',
  );
});
