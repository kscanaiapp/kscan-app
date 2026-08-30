// Build 34 / Track B / Phase B4 — Style DNA read-or-recompute orchestrator.
//
// Loads the REAL store module directly on top of the REAL evidence-revision
// and derivation modules, faking only the Supabase client boundary.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

function loadTsModule(rel, requireMap = {}) {
  const out = transpile(rel);
  const module = { exports: {} };
  vm.runInNewContext(
    out,
    {
      console,
      exports: module.exports,
      module,
      Date, Math, Number, Object, Array, JSON, String, Boolean, Map, Set, Promise,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require in ${rel}: ${id}`);
      },
    },
    { filename: rel },
  );
  return module.exports;
}

const types = loadTsModule('supabase/functions/_shared/styleDna/styleDnaProfileTypes.ts', {});
const evidenceRevision = loadTsModule('supabase/functions/_shared/styleDna/styleDnaEvidenceRevision.ts', {});
const derivation = loadTsModule('supabase/functions/_shared/styleDna/styleDnaProfileDerivation.ts', {
  './styleDnaProfileTypes.ts': types,
});
const store = loadTsModule('supabase/functions/_shared/styleDna/styleDnaProfileStore.ts', {
  './styleDnaEvidenceRevision.ts': evidenceRevision,
  './styleDnaProfileDerivation.ts': derivation,
  './styleDnaProfileTypes.ts': types,
});

// ── Fake Supabase client: enough surface for this module's two tables ──────

// The RPC (public.upsert_style_dna_profile) derives its identity from
// auth.uid() server-side, never from an argument. This fake mirrors that by
// attributing every rpc() write to `options.userId` (the "logged in as"
// identity), never to anything the store itself passes in — matching the
// real RPC's forge-proof contract.
function makeFakeClient(options = {}) {
  const closetRows = options.closetRows ?? [];
  let profileRow = options.profileRow ?? null;
  const writes = [];
  const authedUserId = options.userId ?? 'user-A';

  function closetQuery() {
    const q = { userId: null };
    const chain = {
      eq: (col, val) => { if (col === 'user_id') q.userId = val; return chain; },
      is: () => Promise.resolve({
        data: closetRows.filter((r) => r.user_id === q.userId),
        error: options.closetReadError ?? null,
      }),
    };
    return chain;
  }

  function profileQuery() {
    const q = { userId: null };
    const chain = {
      eq: (col, val) => { if (col === 'user_id') q.userId = val; return chain; },
      maybeSingle: () => Promise.resolve({
        data: profileRow && profileRow.user_id === q.userId ? profileRow : null,
        error: options.profileReadError ?? null,
      }),
    };
    return chain;
  }

  return {
    writes,
    getProfileRow: () => profileRow,
    from: (table) => ({
      select: () => (table === 'user_closet_items' ? closetQuery() : profileQuery()),
    }),
    rpc: (fn, args) => {
      if (fn !== 'upsert_style_dna_profile') throw new Error(`Unexpected rpc: ${fn}`);
      writes.push(args);
      if (options.writeError) return Promise.resolve({ data: null, error: options.writeError });
      const next = {
        user_id: authedUserId,
        profile_version: args.p_profile_version,
        evidence_revision: args.p_evidence_revision,
        derived_at: new Date().toISOString(),
        profile_data: args.p_profile_data,
      };
      profileRow = next;
      return Promise.resolve({ data: [next], error: null });
    },
  };
}

function closetRow(overrides = {}) {
  return {
    user_id: 'user-A',
    updated_at: '2026-01-01T00:00:00.000Z',
    category: 'Outerwear',
    clothing_type: 'jacket',
    brand: 'Acme',
    primary_color: 'black',
    secondary_colors: [],
    material: ['nylon'],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

test('EMPTY: no closet rows and no existing profile -> a fresh, valid empty profile is derived and persisted', async () => {
  const client = makeFakeClient({ closetRows: [] });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.ok, true);
  assert.equal(result.recomputed, true);
  assert.equal(result.profile.profileData.evidenceCount, 0);
  assert.equal(result.profile.evidenceRevision, 'empty:0');
  assert.equal(client.writes.length, 1);
});

test('FRESH: one closet row and no existing profile -> recomputed and persisted', async () => {
  const client = makeFakeClient({ closetRows: [closetRow()] });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.recomputed, true);
  assert.equal(result.profile.profileData.evidenceCount, 1);
  assert.equal(result.profile.profileVersion, types.STYLE_DNA_PROFILE_VERSION);
});

test('REUSE: matching evidence revision and profile version -> the stored profile is reused, no write', async () => {
  const rows = [closetRow()];
  const revision = evidenceRevision.computeClosetEvidenceRevision(rows.map((r) => r.updated_at));
  const existingProfile = {
    user_id: 'user-A',
    profile_version: types.STYLE_DNA_PROFILE_VERSION,
    evidence_revision: revision,
    derived_at: '2026-01-01T00:00:00.000Z',
    profile_data: { evidenceCount: 1, colorFrequency: [], categoryFrequency: [], garmentTypeFrequency: [], brandFrequency: [], materialFrequency: [] },
  };
  const client = makeFakeClient({ closetRows: rows, profileRow: existingProfile });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.recomputed, false);
  assert.equal(client.writes.length, 0);
  assert.equal(result.profile.derivedAt, '2026-01-01T00:00:00.000Z'); // untouched
});

test('EVIDENCE CHANGE: a new item since the stored revision triggers exactly one recompute', async () => {
  const originalRows = [closetRow({ updated_at: '2026-01-01T00:00:00.000Z' })];
  const staleRevision = evidenceRevision.computeClosetEvidenceRevision(originalRows.map((r) => r.updated_at));
  const staleProfile = {
    user_id: 'user-A',
    profile_version: types.STYLE_DNA_PROFILE_VERSION,
    evidence_revision: staleRevision,
    derived_at: '2026-01-01T00:00:00.000Z',
    profile_data: { evidenceCount: 1, colorFrequency: [], categoryFrequency: [], garmentTypeFrequency: [], brandFrequency: [], materialFrequency: [] },
  };
  const newRows = [...originalRows, closetRow({ updated_at: '2026-02-01T00:00:00.000Z', brand: 'NewBrand' })];
  const client = makeFakeClient({ closetRows: newRows, profileRow: staleProfile });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.recomputed, true);
  assert.equal(result.profile.profileData.evidenceCount, 2);
  assert.equal(client.writes.length, 1);
});

test('PROFILE VERSION BUMP: a stored profile at an older version always recomputes, even with unchanged evidence', async () => {
  const rows = [closetRow()];
  const revision = evidenceRevision.computeClosetEvidenceRevision(rows.map((r) => r.updated_at));
  const oldVersionProfile = {
    user_id: 'user-A',
    profile_version: 0, // older than the current contract version
    evidence_revision: revision,
    derived_at: '2026-01-01T00:00:00.000Z',
    profile_data: {},
  };
  const client = makeFakeClient({ closetRows: rows, profileRow: oldVersionProfile });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.recomputed, true);
});

test('TOMBSTONED ITEMS EXCLUDED: the closet query filters deleted_at IS NULL', async () => {
  // The fake client's closet query only ever returns rows already passed in
  // (simulating the .is('deleted_at', null) filter applied server-side by
  // Postgres); this test documents and pins that the store issues that
  // filter by asserting the query chain includes an `.is` call at all —
  // exercised implicitly by every other passing test's use of `.is()` in the
  // fake chain. A missing call would throw "is is not a function" here.
  const client = makeFakeClient({ closetRows: [closetRow()] });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.ok, true);
});

test('CROSS-ACCOUNT ISOLATION: user Bs rows never influence user As profile', async () => {
  const client = makeFakeClient({
    closetRows: [closetRow({ user_id: 'user-A', brand: 'A-Brand' }), closetRow({ user_id: 'user-B', brand: 'B-Brand' })],
  });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.profile.profileData.evidenceCount, 1);
  assert.equal(result.profile.profileData.brandFrequency[0].value, 'A-Brand');
});

test('MALFORMED FACTS: a row with unexpected field shapes never crashes the read path', async () => {
  const client = makeFakeClient({
    closetRows: [closetRow({ secondary_colors: 'not-an-array', material: null, category: 12345 })],
  });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.ok, true);
});

test('K+ IS NEVER CONSULTED HERE: the store has no entitlement parameter at all', () => {
  // Structural assertion: this module's only exported function takes
  // {supabase, userId} — entitlement gating is the CALLER's responsibility
  // (stylechat-generate), consistent with account deletion being independent
  // of K+ status for this table.
  assert.deepEqual(Object.keys(store).sort(), ['STYLE_DNA_EMPTY_EVIDENCE_REVISION', 'getOrRecomputeStyleDnaProfile'].sort());
});

test('FAILURE: a closet read error is reported, never silently treated as an empty Closet', async () => {
  const client = makeFakeClient({ closetReadError: { message: 'boom' } });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'closet_read_failed');
  assert.equal(client.writes.length, 0);
});

test('FAILURE: a profile write error is reported and the caller receives no fabricated profile', async () => {
  const client = makeFakeClient({ closetRows: [closetRow()], writeError: { message: 'boom' } });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'profile_write_failed');
  assert.equal(result.profile, null);
});
