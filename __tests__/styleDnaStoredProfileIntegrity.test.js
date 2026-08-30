// Track B B1A-B5 hostile audit — stored Style DNA profile integrity.
//
// THE INVARIANTS UNDER TEST (audit sections 41 and 80):
//   "profile malformed  -> Elise ignores the unsafe profile and falls back"
//   "Style DNA unavailable -> Closet remains valid; Elise can use non-profile
//    reasoning"
//
// WHY A MALFORMED PROFILE IS REACHABLE AT ALL. public.user_style_profiles
// stores profile_data as jsonb whose only database constraints are
// `jsonb_typeof = 'object'` and `octet_length <= 65536`. Its writer,
// public.upsert_style_dna_profile(), is a SECURITY DEFINER function granted
// to `authenticated` that takes p_profile_data AS A PARAMETER — identity is
// forge-proof (auth.uid()), but the PAYLOAD is not server-derived. Any
// authenticated caller can therefore place an arbitrary object shape in their
// own row, and so can any future schema drift or partial write.
//
// Before this repair, styleDnaProfileStore.mapProfileRow passed profile_data
// through unvalidated and buildServerStyleDnaProfileBlock indexed into it
// directly, so a row of the form {"evidenceCount": 5} threw
//   TypeError: Cannot read properties of undefined (reading 'slice')
// from inside stylechat-generate's request path, at a call site the caller
// does NOT wrap in try/catch — converting an optional personalization signal
// into a total, self-perpetuating Elise failure for that account.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(rel, requireMap = {}) {
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
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
const promptHardening = loadTsModule('supabase/functions/stylechat-generate/promptHardening.ts', {});
const styleDnaContext = loadTsModule('supabase/functions/stylechat-generate/styleDnaContext.ts', {
  './promptHardening.ts': promptHardening,
  '../_shared/styleDna/styleDnaProfileTypes.ts': types,
});

const { isStyleDnaProfileDataV1 } = types;
const { buildServerStyleDnaProfileBlock } = styleDnaContext;

function validProfile(overrides = {}) {
  return {
    evidenceCount: 3,
    colorFrequency: [{ value: 'black', count: 3 }],
    categoryFrequency: [{ value: 'outerwear', count: 2 }],
    garmentTypeFrequency: [{ value: 'jacket', count: 2 }],
    brandFrequency: [{ value: 'Acme', count: 1 }],
    materialFrequency: [{ value: 'nylon', count: 1 }],
    ...overrides,
  };
}

// Shapes an authenticated caller can place in their OWN row through the RPC,
// or that schema drift / a partial write could leave behind.
const MALFORMED_SHAPES = {
  'missing every frequency array': { evidenceCount: 5 },
  'one missing frequency array': (() => {
    const p = validProfile();
    delete p.brandFrequency;
    return p;
  })(),
  'a frequency array that is not an array': validProfile({ colorFrequency: 'black' }),
  'a frequency array of bare strings': validProfile({ categoryFrequency: ['outerwear'] }),
  'a non-string label': validProfile({ colorFrequency: [{ value: 123, count: 1 }] }),
  'a null entry inside a frequency array': validProfile({ materialFrequency: [null] }),
  'a nested-object label': validProfile({ brandFrequency: [{ value: { a: 1 }, count: 1 }] }),
  'a non-numeric count': validProfile({ garmentTypeFrequency: [{ value: 'jacket', count: 'many' }] }),
  'a negative evidence count': validProfile({ evidenceCount: -1 }),
  'a non-numeric evidence count': validProfile({ evidenceCount: '5' }),
  'an array instead of an object': [],
  'an empty object': {},
};

// ── The validator ───────────────────────────────────────────────────────────

test('VALIDATOR: every malformed stored shape is rejected', () => {
  for (const [name, shape] of Object.entries(MALFORMED_SHAPES)) {
    assert.equal(isStyleDnaProfileDataV1(shape), false, `${name} must not validate`);
  }
  assert.equal(isStyleDnaProfileDataV1(null), false);
  assert.equal(isStyleDnaProfileDataV1(undefined), false);
});

test('NEGATIVE CONTROL: a well-formed profile — including a valid empty one — validates', () => {
  assert.equal(isStyleDnaProfileDataV1(validProfile()), true);
  assert.equal(
    isStyleDnaProfileDataV1({
      evidenceCount: 0,
      colorFrequency: [],
      categoryFrequency: [],
      garmentTypeFrequency: [],
      brandFrequency: [],
      materialFrequency: [],
    }),
    true,
    'an empty Closet still derives a valid, empty profile',
  );
  assert.equal(isStyleDnaProfileDataV1(derivation.deriveStyleDnaProfile([])), true);
});

// ── The prompt builder is total ─────────────────────────────────────────────

test('FALLBACK: no malformed profile can throw out of the prompt builder', () => {
  for (const [name, shape] of Object.entries(MALFORMED_SHAPES)) {
    let block;
    assert.doesNotThrow(() => {
      block = buildServerStyleDnaProfileBlock(shape);
    }, `${name} must not throw inside a live chat request`);
    assert.equal(block, null, `${name} must yield no prompt block`);
  }
});

test('NEGATIVE CONTROL: a valid profile still produces its grounded prompt block', () => {
  const block = buildServerStyleDnaProfileBlock(validProfile());
  assert.ok(typeof block === 'string' && block.length > 0);
  assert.match(block, /\[Wardrobe Style DNA/);
  assert.match(block, /Frequent colors: "black"/);
  assert.equal(
    buildServerStyleDnaProfileBlock(validProfile({ evidenceCount: 0 })),
    null,
    'an evidence-free profile still injects nothing',
  );
});

// ── The store treats an unusable stored row as no row ────────────────────────

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
      const next = {
        user_id: authedUserId,
        profile_version: args.p_profile_version,
        evidence_revision: args.p_evidence_revision,
        derived_at: new Date().toISOString(),
        profile_data: options.forceWrittenBack ?? args.p_profile_data,
      };
      profileRow = next;
      return Promise.resolve({ data: [next], error: null });
    },
  };
}

const CLOSET_ROW = {
  user_id: 'user-A',
  updated_at: '2026-01-01T00:00:00.000Z',
  category: 'Outerwear',
  clothing_type: 'jacket',
  brand: 'Acme',
  primary_color: 'black',
  secondary_colors: [],
  material: ['nylon'],
};
const REVISION = '2026-01-01T00:00:00.000Z:1';

test('STORE: a forged, evidence-matching stored profile is not reused — it is recomputed from real Closet evidence', async () => {
  const client = makeFakeClient({
    closetRows: [CLOSET_ROW],
    profileRow: {
      user_id: 'user-A',
      profile_version: 1,
      // The revision matches what the real Closet evidence produces, which is
      // exactly the condition that would otherwise short-circuit to "reuse".
      evidence_revision: REVISION,
      derived_at: '2026-01-01T00:00:00.000Z',
      profile_data: { evidenceCount: 99, brandFrequency: 'Forged Couture' },
    },
  });

  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });

  assert.equal(result.ok, true);
  assert.equal(result.recomputed, true, 'the unusable row must not be reused');
  assert.equal(client.writes.length, 1, 'it is replaced by a real derivation');
  assert.equal(result.profile.profileData.evidenceCount, 1, 'derived from the one real Closet row');
  assert.deepEqual(result.profile.profileData.brandFrequency, [{ value: 'Acme', count: 1 }]);
  assert.equal(isStyleDnaProfileDataV1(result.profile.profileData), true);
});

test('STORE: a malformed row that survives the write path is reported as a failure, never returned', async () => {
  const client = makeFakeClient({
    closetRows: [CLOSET_ROW],
    forceWrittenBack: { evidenceCount: 4 },
  });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.ok, false);
  assert.equal(result.profile, null, 'never hand a caller a profile it cannot interpret');
  assert.equal(result.failureReason, 'profile_write_failed');
});

test('NEGATIVE CONTROL: a valid, evidence-matching stored profile is still reused with no write', async () => {
  const client = makeFakeClient({
    closetRows: [CLOSET_ROW],
    profileRow: {
      user_id: 'user-A',
      profile_version: 1,
      evidence_revision: REVISION,
      derived_at: '2026-01-01T00:00:00.000Z',
      profile_data: derivation.deriveStyleDnaProfile([
        {
          updatedAt: CLOSET_ROW.updated_at,
          category: 'Outerwear',
          clothingType: 'jacket',
          brand: 'Acme',
          primaryColor: 'black',
          secondaryColors: [],
          material: ['nylon'],
        },
      ]),
    },
  });
  const result = await store.getOrRecomputeStyleDnaProfile({ supabase: client, userId: 'user-A' });
  assert.equal(result.ok, true);
  assert.equal(result.recomputed, false, 'the read-or-recompute short circuit still works');
  assert.equal(client.writes.length, 0);
});

// ── The call site cannot reintroduce the throw ───────────────────────────────

test('CALL SITE: index.ts branches on the built block, never on a raw profile field', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/stylechat-generate/index.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /\.profileData\.evidenceCount\s*>\s*0\s*\n?\s*\?/,
    'the prompt must not be gated on a raw payload field the payload may not have',
  );
  assert.match(
    source,
    /const serverStyleDnaBlock = serverStyleDnaProfile[\s\S]{0,160}buildServerStyleDnaProfileBlock/,
    'the block is built first, then branched on',
  );
  assert.doesNotMatch(
    source,
    /\$\{buildServerStyleDnaProfileBlock\(/,
    'a nullable builder result must never be interpolated directly into the prompt',
  );
});
