// Private Dressing Room composition contracts (Build 3 Phase 2, Stage 2).
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const moduleCache = new Map();

function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier === 'expo-crypto') {
      return { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31) % 256) };
    }
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  // runInThisContext, not runInNewContext: a separate realm gives the module its
  // own Array/Object intrinsics, so every array it returns fails
  // assert.deepEqual against a test-side literal for realm reasons that have
  // nothing to do with the code under test. This mirrors
  // __tests__/closetSeparationContract.test.js.
  vm.runInThisContext(`(function (exports, module, require) {\n${output}\n})`, { filename })(
    mod.exports,
    mod,
    localRequire,
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const schema = loadModule('services/privateDressingRoomCompositionSchema.ts');
const types = loadModule('types/privateDressingRoomComposition.ts');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION_ID = 'drsession_abc';

function item(slot, closetItemId) {
  return { slot, closetItemId };
}

function look(overrides = {}) {
  return {
    lookId: 'drlook_1',
    sessionId: SESSION_ID,
    items: [item('top', 'c-top'), item('bottom', 'c-bottom'), item('footwear', 'c-shoes')],
    completeness: 'complete',
    missingSlots: [],
    labelCodes: ['NO_PURCHASE_NEEDED'],
    rank: 0,
    ...overrides,
  };
}

function set(overrides = {}) {
  return {
    compositionId: 'drcomp_1',
    actorId: 'user-a',
    sessionId: SESSION_ID,
    inputFingerprint: 'composer:v1|actor:user-a|session:drsession_abc|status:active|anchor:|occasion:',
    composerVersion: 1,
    activeLookId: null,
    looks: [look()],
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

// ── Identifiers ──────────────────────────────────────────────────────────────

test('composition and look ids are opaque, prefixed and unique in a burst', () => {
  const comps = new Set();
  const looks = new Set();
  for (let i = 0; i < 300; i += 1) {
    comps.add(schema.createCompositionId());
    looks.add(schema.createLookId());
  }
  assert.equal(comps.size, 300);
  assert.equal(looks.size, 300);
  for (const id of comps) assert.match(id, /^drcomp_/);
  for (const id of looks) assert.match(id, /^drlook_/);
});

test('ids never embed the actor id', () => {
  assert.equal(schema.createCompositionId().includes('user-'), false);
  assert.equal(schema.createLookId().includes('user-'), false);
});

// ── Fingerprint ──────────────────────────────────────────────────────────────

test('the fingerprint is deterministic for identical context', () => {
  const input = {
    actorId: 'user-a',
    sessionId: SESSION_ID,
    status: 'active',
    anchorClosetItemId: 'c1',
    occasion: 'Dinner',
  };
  assert.equal(schema.buildCompositionFingerprint(input), schema.buildCompositionFingerprint(input));
});

test('the fingerprint changes with every context component', () => {
  const base = {
    actorId: 'user-a',
    sessionId: SESSION_ID,
    status: 'active',
    anchorClosetItemId: 'c1',
    occasion: 'Dinner',
  };
  const baseline = schema.buildCompositionFingerprint(base);
  const variants = [
    { ...base, actorId: 'user-b' },
    { ...base, sessionId: 'drsession_other' },
    { ...base, status: 'discarded' },
    { ...base, anchorClosetItemId: 'c2' },
    { ...base, occasion: 'Work' },
    { ...base, anchorClosetItemId: null },
    { ...base, occasion: null },
  ];
  for (const variant of variants) {
    assert.notEqual(
      schema.buildCompositionFingerprint(variant),
      baseline,
      `fingerprint must change for ${JSON.stringify(variant)}`,
    );
  }
});

test('occasion normalization ignores case and whitespace but not meaning', () => {
  const at = (occasion) =>
    schema.buildCompositionFingerprint({
      actorId: 'a',
      sessionId: 's',
      status: 'active',
      occasion,
    });
  assert.equal(at('Dinner'), at('  dinner  '));
  assert.equal(at('Black Tie'), at('black   tie'));
  assert.notEqual(at('Dinner'), at('Dinner party'));
});

test('a discarded session cannot share a fingerprint with its active self', () => {
  const active = schema.buildCompositionFingerprint({
    actorId: 'user-a',
    sessionId: SESSION_ID,
    status: 'active',
  });
  const discarded = schema.buildCompositionFingerprint({
    actorId: 'user-a',
    sessionId: SESSION_ID,
    status: 'discarded',
  });
  assert.notEqual(active, discarded);
});

test('isCompositionCurrent compares the stored fingerprint', () => {
  const record = set();
  assert.equal(schema.isCompositionCurrent(record, record.inputFingerprint), true);
  assert.equal(schema.isCompositionCurrent(record, 'something-else'), false);
  assert.equal(schema.isCompositionCurrent(null, record.inputFingerprint), false);
});

test('the fingerprint is a canonical string, not a lossy hash', () => {
  const value = schema.buildCompositionFingerprint({
    actorId: 'user-a',
    sessionId: SESSION_ID,
    status: 'active',
    anchorClosetItemId: 'c1',
    occasion: 'Dinner',
  });
  assert.match(value, /^composer:v1\|actor:user-a\|session:drsession_abc\|status:active\|anchor:c1\|occasion:dinner$/);
});

// ── Valid records ────────────────────────────────────────────────────────────

test('valid one-, two- and three-look compositions round-trip', () => {
  for (const count of [1, 2, 3]) {
    const looks = [];
    for (let i = 0; i < count; i += 1) {
      looks.push(
        look({
          lookId: `drlook_${i}`,
          rank: i,
          items: [item('top', `t${i}`), item('bottom', `b${i}`), item('footwear', `s${i}`)],
        }),
      );
    }
    const result = schema.validateCompositionRecord(set({ looks }));
    assert.equal(result.ok, true, `count ${count}`);
    assert.equal(result.record.looks.length, count);
  }
});

test('a partial look with truthful missing slots is valid', () => {
  const result = schema.validateCompositionRecord(
    set({
      looks: [
        look({
          items: [item('top', 'c-top'), item('bottom', 'c-bottom')],
          completeness: 'partial',
          missingSlots: ['footwear'],
          labelCodes: ['PARTIAL_LOOK'],
        }),
      ],
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.looks[0].missingSlots, ['footwear']);
});

test('a dress look needs no top or bottom', () => {
  const result = schema.validateCompositionRecord(
    set({ looks: [look({ items: [item('dress', 'c-dress'), item('footwear', 'c-shoes')] })] }),
  );
  assert.equal(result.ok, true);
});

test('an active look referencing an existing look is valid', () => {
  const result = schema.validateCompositionRecord(set({ activeLookId: 'drlook_1' }));
  assert.equal(result.ok, true);
  assert.equal(result.record.activeLookId, 'drlook_1');
});

// ── Invariant violations ─────────────────────────────────────────────────────

test('duplicate look ids are refused', () => {
  const result = schema.validateCompositionRecord(
    set({
      looks: [
        look({ lookId: 'same', rank: 0 }),
        look({
          lookId: 'same',
          rank: 1,
          items: [item('top', 'x'), item('bottom', 'y'), item('footwear', 'z')],
        }),
      ],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'composition_store_corrupt');
});

test('duplicate ranks are refused', () => {
  const result = schema.validateCompositionRecord(
    set({
      looks: [
        look({ lookId: 'a', rank: 0 }),
        look({
          lookId: 'b',
          rank: 0,
          items: [item('top', 'x'), item('bottom', 'y'), item('footwear', 'z')],
        }),
      ],
    }),
  );
  assert.equal(result.ok, false);
});

test('the same garment twice in one look is refused', () => {
  const result = schema.validateCompositionRecord(
    set({ looks: [look({ items: [item('top', 'dup'), item('bottom', 'dup')] })] }),
  );
  assert.equal(result.ok, false);
});

test('two garments in the same slot are refused', () => {
  const result = schema.validateCompositionRecord(
    set({ looks: [look({ items: [item('top', 'a'), item('top', 'b')] })] }),
  );
  assert.equal(result.ok, false);
});

test('two looks with the identical garment set are refused as duplicates', () => {
  const items = [item('top', 't'), item('bottom', 'b'), item('footwear', 's')];
  const result = schema.validateCompositionRecord(
    set({
      looks: [
        look({ lookId: 'a', rank: 0, items }),
        // Same set, different order — still the same outfit.
        look({ lookId: 'b', rank: 1, items: [items[2], items[0], items[1]] }),
      ],
    }),
  );
  assert.equal(result.ok, false);
});

test('an activeLookId that names no look is refused', () => {
  const result = schema.validateCompositionRecord(set({ activeLookId: 'drlook_missing' }));
  assert.equal(result.ok, false);
});

test('a look naming a different session is refused', () => {
  const result = schema.validateCompositionRecord(
    set({ looks: [look({ sessionId: 'drsession_other' })] }),
  );
  assert.equal(result.ok, false);
});

test('a complete look claiming missing slots is refused', () => {
  const result = schema.validateCompositionRecord(
    set({ looks: [look({ completeness: 'complete', missingSlots: ['outerwear'] })] }),
  );
  assert.equal(result.ok, false);
});

test('a partial look claiming nothing is missing is refused', () => {
  const result = schema.validateCompositionRecord(
    set({ looks: [look({ completeness: 'partial', missingSlots: [] })] }),
  );
  assert.equal(result.ok, false);
});

test('a slot that is both filled and missing is refused', () => {
  const result = schema.validateCompositionRecord(
    set({
      looks: [
        look({ completeness: 'partial', missingSlots: ['top'] }),
      ],
    }),
  );
  assert.equal(result.ok, false);
});

test('an unsupported slot is refused', () => {
  for (const slot of ['bag', 'other', 'hat', '', null, 42]) {
    const result = schema.validateCompositionRecord(
      set({ looks: [look({ items: [item(slot, 'x')] })] }),
    );
    assert.equal(result.ok, false, `slot ${JSON.stringify(slot)}`);
  }
});

test('an unknown label code is refused', () => {
  const result = schema.validateCompositionRecord(
    set({ looks: [look({ labelCodes: ['LOOKS_GREAT'] })] }),
  );
  assert.equal(result.ok, false);
});

test('zero looks and more than three looks are refused', () => {
  assert.equal(schema.validateCompositionRecord(set({ looks: [] })).ok, false);
  const four = [0, 1, 2, 3].map((i) =>
    look({
      lookId: `l${i}`,
      rank: i,
      items: [item('top', `t${i}`), item('bottom', `b${i}`), item('footwear', `s${i}`)],
    }),
  );
  assert.equal(schema.validateCompositionRecord(set({ looks: four })).ok, false);
});

// ── Version behavior ─────────────────────────────────────────────────────────

test('a future schema version is refused with its own code', () => {
  const result = schema.validateCompositionRecord(set({ schemaVersion: 2 }));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'composition_store_future_schema');
});

test('a missing or older schema version is refused', () => {
  for (const version of [undefined, null, 0, -1, '1']) {
    const result = schema.validateCompositionRecord(set({ schemaVersion: version }));
    assert.equal(result.ok, false, `version ${JSON.stringify(version)}`);
  }
});

test('a different composer version is refused rather than reinterpreted', () => {
  const future = schema.validateCompositionRecord(set({ composerVersion: 2 }));
  assert.equal(future.ok, false);
  assert.equal(future.errorCode, 'composition_store_future_schema');

  const older = schema.validateCompositionRecord(set({ composerVersion: 0 }));
  assert.equal(older.ok, false);
  assert.equal(older.errorCode, 'composition_store_corrupt');
});

// ── Allowlisting ─────────────────────────────────────────────────────────────

test('unknown fields are stripped from the set, looks and items', () => {
  const tampered = set({
    injected: true,
    savedLookId: 'look-1',
    looks: [
      {
        ...look({
          items: [{ ...item('top', 'c-top'), price: '$40', imageUri: 'file:///x.jpg' }],
        }),
        retailer: 'Example',
        swapHistory: [],
      },
    ],
  });
  const result = schema.validateCompositionRecord(tampered);
  assert.equal(result.ok, true);
  assert.deepEqual(
    Object.keys(result.record).sort(),
    [...types.PRIVATE_COMPOSITION_FIELDS].sort(),
  );
  assert.deepEqual(
    Object.keys(result.record.looks[0]).sort(),
    [...types.PRIVATE_LOOK_FIELDS].sort(),
  );
  assert.deepEqual(
    Object.keys(result.record.looks[0].items[0]).sort(),
    [...types.PRIVATE_OUTFIT_ITEM_FIELDS].sort(),
  );
});

test('no garment metadata is representable on a composed item', () => {
  const result = schema.validateCompositionRecord(set());
  const composed = result.record.looks[0].items[0];
  for (const forbidden of [
    'title',
    'brand',
    'primaryColor',
    'material',
    'imageUri',
    'thumbnailUri',
    'size',
    'category',
    'price',
    'retailer',
  ]) {
    assert.equal(forbidden in composed, false, `must not duplicate ${forbidden}`);
  }
});

test('no Saved Look, commerce or swap field is allowlisted', () => {
  for (const forbidden of [
    'lookId2',
    'savedLookId',
    'commerce',
    'purchaseOptions',
    'retailer',
    'affiliateUrl',
    'swapHistory',
    'comparison',
  ]) {
    assert.equal(
      types.PRIVATE_COMPOSITION_FIELDS.includes(forbidden),
      false,
      `${forbidden} must not be a composition field`,
    );
    assert.equal(types.PRIVATE_LOOK_FIELDS.includes(forbidden), false);
  }
});

test('structurally invalid records fail closed', () => {
  for (const raw of [null, undefined, 'nope', 42, [], {}]) {
    const result = schema.validateCompositionRecord(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.errorCode, 'composition_store_corrupt');
  }
});

// ── Construction and revision ────────────────────────────────────────────────

test('buildCompositionSet stamps versions and equal timestamps', () => {
  const now = '2026-07-28T12:00:00.000Z';
  const built = schema.buildCompositionSet({
    actorId: 'user-a',
    sessionId: SESSION_ID,
    inputFingerprint: 'fp',
    looks: [look()],
    now,
  });
  assert.equal(built.schemaVersion, 1);
  assert.equal(built.composerVersion, 1);
  assert.equal(built.createdAt, now);
  assert.equal(built.updatedAt, now);
  assert.equal(built.activeLookId, null);
});

test('revision changes the selection and never the looks or createdAt', () => {
  const built = schema.buildCompositionSet({
    actorId: 'user-a',
    sessionId: SESSION_ID,
    inputFingerprint: 'fp',
    looks: [look()],
    now: '2026-07-28T12:00:00.000Z',
  });
  const revised = schema.reviseCompositionSet(
    built,
    { activeLookId: 'drlook_1' },
    '2026-07-28T13:00:00.000Z',
  );
  assert.equal(revised.activeLookId, 'drlook_1');
  assert.equal(revised.createdAt, built.createdAt);
  assert.equal(revised.updatedAt, '2026-07-28T13:00:00.000Z');
  assert.deepEqual(revised.looks, built.looks);
  assert.equal(revised.compositionId, built.compositionId);
  assert.equal(revised.inputFingerprint, built.inputFingerprint);
});

test('collectCompositionItemIds returns each referenced garment once', () => {
  const record = set({
    looks: [
      look({ lookId: 'a', rank: 0 }),
      look({
        lookId: 'b',
        rank: 1,
        items: [item('top', 'c-top'), item('bottom', 'other'), item('footwear', 'c-shoes')],
      }),
    ],
  });
  const ids = schema.collectCompositionItemIds(record).sort();
  assert.deepEqual(ids, ['c-bottom', 'c-shoes', 'c-top', 'other']);
  assert.deepEqual(schema.collectCompositionItemIds(null), []);
});

// ── Domain boundaries ────────────────────────────────────────────────────────

test('the slot set excludes bag and other', () => {
  assert.deepEqual(
    [...types.PRIVATE_SLOTS],
    ['top', 'bottom', 'dress', 'outerwear', 'footwear', 'accessory'],
  );
  assert.equal(types.isPrivateSlot('bag'), false);
  assert.equal(types.isPrivateSlot('other'), false);
});

test('optional slots are not required for completeness', () => {
  for (const coreSet of types.PRIVATE_CORE_SLOT_SETS) {
    assert.equal(coreSet.includes('outerwear'), false);
    assert.equal(coreSet.includes('accessory'), false);
  }
  assert.deepEqual([...types.PRIVATE_OPTIONAL_SLOTS], ['outerwear', 'accessory']);
});

test('the schema module imports no other outfit domain', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCompositionSchema.ts'),
    'utf8',
  );
  const imports = source.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of [
      'styleObjects',
      'styleOutfits',
      'outfitDecisions',
      'free-tier',
      'savedOutfits',
      'supabaseClient',
    ]) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}: ${line}`);
    }
  }
});
