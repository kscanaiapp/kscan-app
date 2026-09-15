/**
 * SIGNATURE_STYLE_ENTITLEMENT=FREE — behavioural regression suite.
 *
 * Build 34 owner authority made Signature Style part of the free K Scan AI
 * product. public.recompute_signature_style() had required an active K+
 * entitlement since it was introduced, so an authenticated free user's
 * recompute failed with 42501 and they could neither generate nor view a
 * Signature Style. 20260915232402_signature_style_free_closet_evidence.sql removes
 * that requirement -- and only that requirement.
 *
 * WHAT THIS SUITE IS
 *
 * The named journeys from the repair brief, driven through the real modules
 * that implement them:
 *
 *   FREE_AUTHENTICATED_SIGNATURE_STYLE_ACCESS
 *   FREE_AUTHENTICATED_SIGNATURE_STYLE_RECOMPUTE
 *   KPLUS_SIGNATURE_STYLE_ACCESS
 *   KPLUS_SIGNATURE_STYLE_RECOMPUTE
 *   SIGNED_OUT_BEHAVIOR
 *   CROSS_USER_SIGNATURE_STYLE_READ
 *   CROSS_USER_SIGNATURE_STYLE_RECOMPUTE
 *   ANON_PRIVILEGE_NOT_BROADENED
 *
 * The K+/free distinction is a DATABASE decision, so the entitlement journeys
 * are driven where this repository can actually execute them -- the Edge
 * Function's RPC client -- with the database's answer simulated on each side of
 * the boundary. The SQL-level controls the database alone can enforce
 * (auth.uid() ownership scoping, the 28000 signed-out refusal, RLS, the anon
 * privilege set) are asserted against the authoritative migration text here,
 * and were additionally exercised live on staging with synthetic actors -- see
 * the PR description for that proof.
 *
 * The product contract itself (SIGNATURE_STYLE=FREE, SMART_WATCHLIST=KPLUS) is
 * pinned in __tests__/build34EntitlementMatrix.test.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(rel, requireMap = {}) {
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, {
    console, exports: module.exports, module, Date, Math, Number, Object, Array, JSON, String, Boolean, Promise,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require in ${rel}: ${id}`);
    },
  }, { filename: rel });
  return module.exports;
}

const types = loadTsModule('supabase/functions/_shared/signatureStyle/signatureStyleProfileTypes.ts');
const store = loadTsModule('supabase/functions/_shared/signatureStyle/signatureStyleProfileStore.ts', {
  './signatureStyleProfileTypes.ts': types,
});

const AUTHORITATIVE_MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260915232402_signature_style_free_closet_evidence.sql'),
  'utf8',
);
const PROFILE_TABLE_MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260830060000_user_style_profiles.sql'),
  'utf8',
);

// ── Database simulation ───────────────────────────────────────────────────
//
// One fake `recompute_signature_style` whose behaviour is exactly the
// authoritative function's: it derives the row from the CALLER, never from
// anything the caller passes, and it refuses an unauthenticated caller. The
// K+ answer is supplied so each journey can be run on both sides of the
// boundary the repair moved.

function profileData(evidenceCount) {
  return {
    evidenceCount,
    colorFrequency: evidenceCount ? [{ value: 'black', count: evidenceCount }] : [],
    categoryFrequency: evidenceCount ? [{ value: 'Outerwear', count: evidenceCount }] : [],
    garmentTypeFrequency: evidenceCount ? [{ value: 'jacket', count: evidenceCount }] : [],
    brandFrequency: evidenceCount ? [{ value: 'Acme', count: evidenceCount }] : [],
    materialFrequency: evidenceCount ? [{ value: 'wool', count: evidenceCount }] : [],
  };
}

const CLOSETS = { 'user-free': 2, 'user-kplus': 5, 'user-other': 9 };

/**
 * @param {{ authUid: string|null, kPlusActive: boolean, requireKPlus?: boolean }} actor
 *   `requireKPlus` reinstates the PRE-REPAIR gate, so the suite can prove the
 *   defect it closes rather than only asserting the post-repair shape.
 */
function fakeSupabase(actor, callLog = []) {
  return {
    rpc(fn, args) {
      callLog.push({ fn, args });
      if (fn !== 'recompute_signature_style') {
        return Promise.resolve({ data: null, error: { code: '42883', message: 'no such function' } });
      }
      // 28000 -- auth.uid() is null. Unchanged by the repair.
      if (!actor.authUid) {
        return Promise.resolve({
          data: null,
          error: { code: '28000', message: 'not authenticated' },
        });
      }
      // 42501 -- the removed K+ gate, reinstated only by an explicit opt-in.
      if (actor.requireKPlus && !actor.kPlusActive) {
        return Promise.resolve({
          data: null,
          error: { code: '42501', message: 'active K+ entitlement required' },
        });
      }
      // The row is built from the CALLER's identity and the CALLER's own
      // Closet evidence. `args` is structurally incapable of redirecting it:
      // the real function takes none.
      const evidenceCount = CLOSETS[actor.authUid] ?? 0;
      return Promise.resolve({
        data: [{
          user_id: actor.authUid,
          profile_version: 1,
          evidence_revision: evidenceCount ? `2026-09-15T00:00:00.000Z:${evidenceCount}` : 'empty:0',
          derived_at: '2026-09-15T00:00:00.000Z',
          profile_data: profileData(evidenceCount),
          recomputed: true,
        }],
        error: null,
      });
    },
  };
}

// ── FREE authenticated actor ──────────────────────────────────────────────

test('FREE_AUTHENTICATED_SIGNATURE_STYLE_RECOMPUTE: a free user can recompute', async () => {
  const calls = [];
  const result = await store.getOrRecomputeSignatureStyleProfile({
    supabase: fakeSupabase({ authUid: 'user-free', kPlusActive: false }, calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.recomputed, true);
  assert.equal(result.failureReason, undefined);
  // Zero-argument contract: the free user asks for work, supplies nothing.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'recompute_signature_style');
  assert.deepEqual(Object.keys(calls[0].args), []);
});

test('FREE_AUTHENTICATED_SIGNATURE_STYLE_ACCESS: a free user sees their own resulting profile', async () => {
  const result = await store.getOrRecomputeSignatureStyleProfile({
    supabase: fakeSupabase({ authUid: 'user-free', kPlusActive: false }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.profile.userId, 'user-free');
  assert.equal(result.profile.profileVersion, 1);
  assert.equal(result.profile.profileData.evidenceCount, CLOSETS['user-free']);
});

test('REGRESSION PIN: the pre-repair K+ gate is exactly what broke the free user', async () => {
  // Same call, same actor, with the removed gate reinstated. If this ever
  // starts passing, the simulation stopped modelling the defect and the
  // assertions above stopped meaning anything.
  const result = await store.getOrRecomputeSignatureStyleProfile({
    supabase: fakeSupabase({ authUid: 'user-free', kPlusActive: false, requireKPlus: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.profile, null);
  assert.equal(result.failureReason, 'profile_recompute_failed');
});

// ── K+ actor: unchanged ───────────────────────────────────────────────────

test('KPLUS_SIGNATURE_STYLE_RECOMPUTE: an active K+ user can still recompute', async () => {
  const calls = [];
  const result = await store.getOrRecomputeSignatureStyleProfile({
    supabase: fakeSupabase({ authUid: 'user-kplus', kPlusActive: true }, calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.recomputed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'recompute_signature_style');
  assert.deepEqual(Object.keys(calls[0].args), []);
});

test('KPLUS_SIGNATURE_STYLE_ACCESS: an active K+ user sees their own resulting profile', async () => {
  const result = await store.getOrRecomputeSignatureStyleProfile({
    supabase: fakeSupabase({ authUid: 'user-kplus', kPlusActive: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.profile.userId, 'user-kplus');
  assert.equal(result.profile.profileData.evidenceCount, CLOSETS['user-kplus']);
});

test('KPLUS_SIGNATURE_STYLE_*: the K+ result is identical with the pre-repair gate in place', async () => {
  // The repair must not have changed the K+ journey in any way.
  const before = await store.getOrRecomputeSignatureStyleProfile({
    supabase: fakeSupabase({ authUid: 'user-kplus', kPlusActive: true, requireKPlus: true }),
  });
  const after = await store.getOrRecomputeSignatureStyleProfile({
    supabase: fakeSupabase({ authUid: 'user-kplus', kPlusActive: true }),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
});

// ── Signed out ────────────────────────────────────────────────────────────

test('SIGNED_OUT_BEHAVIOR: an unauthenticated caller is still refused, and no profile is invented', async () => {
  const result = await store.getOrRecomputeSignatureStyleProfile({
    supabase: fakeSupabase({ authUid: null, kPlusActive: false }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.profile, null);
  assert.equal(result.failureReason, 'profile_recompute_failed');
});

test('SIGNED_OUT_BEHAVIOR: the authoritative function still raises 28000 on a null auth.uid()', () => {
  assert.match(AUTHORITATIVE_MIGRATION, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(AUTHORITATIVE_MIGRATION, /if v_user_id is null then/);
  assert.match(
    AUTHORITATIVE_MIGRATION,
    /raise exception 'not authenticated' using errcode = '28000'/,
  );
});

// ── Cross-user isolation ──────────────────────────────────────────────────

test('CROSS_USER_SIGNATURE_STYLE_RECOMPUTE: one actor cannot recompute another actor\'s profile', async () => {
  // The client-side surface for this attack does not exist: the RPC takes no
  // arguments, so there is nothing to point at another user. Proven by sending
  // a hostile payload anyway and observing that the store drops it AND that the
  // row that comes back is still the caller's own.
  const calls = [];
  const hostile = fakeSupabase({ authUid: 'user-free', kPlusActive: false }, calls);
  const result = await store.getOrRecomputeSignatureStyleProfile({
    supabase: {
      rpc: (fn, _args) => hostile.rpc(fn, { p_user_id: 'user-other', user_id: 'user-other' }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.profile.userId, 'user-free', 'the profile must belong to the CALLER');
  assert.notEqual(result.profile.profileData.evidenceCount, CLOSETS['user-other']);
  assert.equal(result.profile.profileData.evidenceCount, CLOSETS['user-free']);
  // And the store itself never forwards an identity argument.
  assert.deepEqual(
    calls.map((c) => c.fn),
    ['recompute_signature_style'],
  );
  const source = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/_shared/signatureStyle/signatureStyleProfileStore.ts'),
    'utf8',
  );
  assert.match(source, /rpc\('recompute_signature_style', \{\}\)/);
  assert.doesNotMatch(source, /p_user_id|p_profile_data|p_evidence_revision/);
  assert.doesNotMatch(source, /\.from\(/, 'the store must never reach the table directly');
});

test('CROSS_USER_SIGNATURE_STYLE_RECOMPUTE: every read and write in the function is scoped to auth.uid()', () => {
  const body = AUTHORITATIVE_MIGRATION.split('as $$')[1];
  // Structural, not a magic count: EVERY owned-item source read plus the profile
  // lookup must carry an owner scope, so adding a legitimate new evidence source
  // can never silently add an unscoped read.
  const executableBody = body.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const reads = [...executableBody.matchAll(/from public\.(\w+)/g)];
  assert.ok(reads.length >= 3, 'expected both evidence sources plus the profile lookup');
  for (let i = 0; i < reads.length; i += 1) {
    const start = reads[i].index;
    const end = i + 1 < reads.length ? reads[i + 1].index : executableBody.length;
    assert.match(executableBody.slice(start, end), /user_id = v_user_id/,
      `public.${reads[i][1]} is read without an owner scope`);
  }
  assert.match(body, /on conflict \(user_id\) do update/);
  // Zero-argument signature: there is no parameter to forge.
  assert.match(
    AUTHORITATIVE_MIGRATION,
    /create or replace function public\.recompute_signature_style\(\)/,
  );
  assert.doesNotMatch(
    AUTHORITATIVE_MIGRATION,
    /create or replace function public\.recompute_signature_style\(\s*p_/,
  );
});

test('CROSS_USER_SIGNATURE_STYLE_READ: RLS still admits only the owner\'s own row', () => {
  assert.match(PROFILE_TABLE_MIGRATION, /alter table public\.user_style_profiles enable row level security;/);
  assert.match(
    PROFILE_TABLE_MIGRATION,
    /create policy "Users can select own style profile"[\s\S]*?using \(auth\.uid\(\) = user_id\)/,
  );
  // The repair added no policy of its own, and loosened none.
  assert.doesNotMatch(AUTHORITATIVE_MIGRATION, /create policy/i);
  assert.doesNotMatch(AUTHORITATIVE_MIGRATION, /drop policy/i);
  assert.doesNotMatch(AUTHORITATIVE_MIGRATION, /disable row level security/i);
  assert.doesNotMatch(AUTHORITATIVE_MIGRATION, /alter table/i);
});

// ── Anonymous / privilege surface ─────────────────────────────────────────

test('ANON_PRIVILEGE_NOT_BROADENED: the repair grants nothing new to anon, public or service_role', () => {
  assert.match(
    AUTHORITATIVE_MIGRATION,
    /revoke all on function public\.recompute_signature_style\(\) from public, anon;/,
  );
  assert.match(
    AUTHORITATIVE_MIGRATION,
    /grant execute on function public\.recompute_signature_style\(\) to authenticated;/,
  );
  // `authenticated` is the ONLY grantee this migration names.
  const grants = [...AUTHORITATIVE_MIGRATION.matchAll(/^\s*grant\s+[\s\S]*?\bto\s+([a-z_, ]+);/gim)]
    .map((m) => m[1].trim());
  assert.deepEqual(grants, ['authenticated']);
  // And it touches no other object's privileges at all.
  assert.doesNotMatch(AUTHORITATIVE_MIGRATION, /grant [^;]*on (table|public\.user_)/i);
});

test('ANON_PRIVILEGE_NOT_BROADENED: the K+ predicate and every other K+ boundary are untouched', () => {
  // The repair must not redefine, weaken or re-grant the shared predicate that
  // Closet RLS, Voice Scan, VTO, Packing, Wardrobe Concierge and Smart
  // Watchlist all still depend on.
  for (const forbidden of [
    /create or replace function public\.has_active_k_plus/i,
    /create or replace function public\.kplus_/i,
    /grant [^;]*has_active_k_plus/i,
    /grant [^;]*kplus_/i,
    /drop function/i,
  ]) {
    assert.doesNotMatch(AUTHORITATIVE_MIGRATION, forbidden);
  }
  // Exactly one function is redefined by this migration.
  assert.equal(
    [...AUTHORITATIVE_MIGRATION.matchAll(/create or replace function/gi)].length,
    1,
  );
});
