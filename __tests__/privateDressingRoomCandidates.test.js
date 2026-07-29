// Eligible slot alternatives (Build 3 Phase 3, Stage 2).
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
      return { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 3) % 256) };
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
  vm.runInThisContext(`(function (exports, module, require) {\n${output}\n})`, { filename })(
    mod.exports,
    mod,
    localRequire,
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const candidates = loadModule('services/privateDressingRoomCandidates.ts');
const effective = loadModule('services/privateDressingRoomEffectiveLook.ts');
const projection = loadModule('services/closetItemProjection.ts');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function item(id, subtype, extra = {}) {
  return projection.getClosetItemProjection({
    id,
    title: id,
    subtype,
    primaryColor: 'black',
    imageUri: `file:///doc/kscan_closet/images/${id}.jpg`,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

const CLOSET = [
  item('c-blazer', 'blazer'),
  item('c-coat', 'coat', { primaryColor: 'camel' }),
  item('c-shirt', 'shirt', { primaryColor: 'white' }),
  item('c-knit', 'sweater', { primaryColor: 'navy' }),
  item('c-blouse', 'blouse', { primaryColor: 'ivory' }),
  item('c-trousers', 'trousers', { primaryColor: 'charcoal' }),
  item('c-jeans', 'jeans', { primaryColor: 'denim' }),
  item('c-skirt', 'skirt'),
  item('c-dress', 'dress', { primaryColor: 'navy' }),
  item('c-gown', 'gown', { primaryColor: 'black' }),
  item('c-loafers', 'loafers', { primaryColor: 'brown' }),
  item('c-boots', 'boots'),
  item('c-sneakers', 'sneakers', { primaryColor: 'white' }),
  item('c-scarf', 'scarf', { primaryColor: 'grey' }),
  item('c-belt', 'belt'),
  item('c-tote', 'tote bag'),
];

function look(overrides = {}) {
  const base = {
    lookId: 'drlook_0',
    sessionId: 'drsession_1',
    items: [
      { slot: 'outerwear', closetItemId: 'c-blazer' },
      { slot: 'top', closetItemId: 'c-shirt' },
      { slot: 'bottom', closetItemId: 'c-trousers' },
      { slot: 'footwear', closetItemId: 'c-loafers' },
    ],
    completeness: 'complete',
    missingSlots: [],
    labelCodes: [],
    rank: 0,
    ...overrides,
  };
  return effective.projectEffectiveLook(base, []).look;
}

function rank(slot, extra = {}) {
  return candidates.rankSlotCandidates({
    look: look(),
    slot,
    closetItems: CLOSET,
    ...extra,
  });
}

const ids = (result) => result.candidates.map((candidate) => candidate.closetItemId);

// ── Per-slot alternatives ────────────────────────────────────────────────────

test('top alternatives are tops only', () => {
  const result = rank('top');
  assert.equal(result.code, 'READY');
  assert.deepEqual(ids(result).sort(), ['c-blouse', 'c-knit']);
});

test('bottom alternatives are bottoms only', () => {
  const result = rank('bottom');
  assert.equal(result.code, 'READY');
  assert.deepEqual(ids(result).sort(), ['c-jeans', 'c-skirt']);
});

test('outerwear alternatives are outerwear only', () => {
  const result = rank('outerwear', { anchorClosetItemId: null });
  assert.equal(result.code, 'READY');
  assert.deepEqual(ids(result), ['c-coat']);
});

test('footwear alternatives are footwear only', () => {
  const result = rank('footwear');
  assert.equal(result.code, 'READY');
  assert.deepEqual(ids(result).sort(), ['c-boots', 'c-sneakers']);
});

test('dress alternatives are one-pieces only', () => {
  const dressLook = effective.projectEffectiveLook(
    {
      lookId: 'drlook_2',
      sessionId: 'drsession_1',
      items: [
        { slot: 'dress', closetItemId: 'c-dress' },
        { slot: 'footwear', closetItemId: 'c-loafers' },
      ],
      completeness: 'complete',
      missingSlots: [],
      labelCodes: [],
      rank: 0,
    },
    [],
  ).look;
  const result = candidates.rankSlotCandidates({
    look: dressLook,
    slot: 'dress',
    closetItems: CLOSET,
  });
  assert.equal(result.code, 'READY');
  assert.deepEqual(ids(result), ['c-gown']);
});

test('accessory alternatives are accessories only', () => {
  const withAccessory = effective.projectEffectiveLook(
    {
      lookId: 'drlook_3',
      sessionId: 'drsession_1',
      items: [
        { slot: 'top', closetItemId: 'c-shirt' },
        { slot: 'bottom', closetItemId: 'c-trousers' },
        { slot: 'footwear', closetItemId: 'c-loafers' },
        { slot: 'accessory', closetItemId: 'c-scarf' },
      ],
      completeness: 'complete',
      missingSlots: [],
      labelCodes: [],
      rank: 0,
    },
    [],
  ).look;
  const result = candidates.rankSlotCandidates({
    look: withAccessory,
    slot: 'accessory',
    closetItems: CLOSET,
  });
  assert.equal(result.code, 'READY');
  assert.deepEqual(ids(result), ['c-belt']);
});

// ── STRICT SLOT BOUNDARIES ───────────────────────────────────────────────────

test('a dress is NEVER offered for a top or bottom slot', () => {
  for (const slot of ['top', 'bottom']) {
    const result = rank(slot);
    assert.equal(ids(result).includes('c-dress'), false, `${slot} must not offer a dress`);
    assert.equal(ids(result).includes('c-gown'), false);
  }
});

test('a top or bottom is NEVER offered for a dress slot', () => {
  const dressLook = effective.projectEffectiveLook(
    {
      lookId: 'drlook_2',
      sessionId: 'drsession_1',
      items: [
        { slot: 'dress', closetItemId: 'c-dress' },
        { slot: 'footwear', closetItemId: 'c-loafers' },
      ],
      completeness: 'complete',
      missingSlots: [],
      labelCodes: [],
      rank: 0,
    },
    [],
  ).look;
  const result = candidates.rankSlotCandidates({
    look: dressLook,
    slot: 'dress',
    closetItems: CLOSET,
  });
  for (const forbidden of ['c-shirt', 'c-knit', 'c-blouse', 'c-trousers', 'c-jeans', 'c-skirt']) {
    assert.equal(ids(result).includes(forbidden), false, `dress must not offer ${forbidden}`);
  }
});

test('a cardigan is not offered as a top, despite its Phase 2 secondary role', () => {
  // The composer may place a cardigan in `top` to complete an outfit. A SWAP
  // may not: that would change the structural template while claiming one slot.
  const closet = [...CLOSET, item('c-cardigan', 'cardigan')];
  const result = candidates.rankSlotCandidates({ look: look(), slot: 'top', closetItems: closet });
  assert.equal(ids(result).includes('c-cardigan'), false);
  const outerwear = candidates.rankSlotCandidates({
    look: look(),
    slot: 'outerwear',
    closetItems: closet,
  });
  assert.equal(ids(outerwear).includes('c-cardigan'), true, 'it is still valid outerwear');
});

// ── Exclusions ───────────────────────────────────────────────────────────────

test('the current item is excluded', () => {
  assert.equal(ids(rank('top')).includes('c-shirt'), false);
});

test('an item already worn in another slot is excluded', () => {
  const closet = [...CLOSET, item('c-dual', 'shirt')];
  const withDual = effective.projectEffectiveLook(
    {
      lookId: 'drlook_0',
      sessionId: 'drsession_1',
      items: [
        { slot: 'top', closetItemId: 'c-dual' },
        { slot: 'bottom', closetItemId: 'c-trousers' },
        { slot: 'footwear', closetItemId: 'c-loafers' },
      ],
      completeness: 'complete',
      missingSlots: [],
      labelCodes: [],
      rank: 0,
    },
    [],
  ).look;
  const result = candidates.rankSlotCandidates({
    look: withDual,
    slot: 'footwear',
    closetItems: closet,
  });
  assert.equal(ids(result).includes('c-dual'), false, 'it is already worn as the top');
});

test('unsupported taxonomy is excluded', () => {
  for (const slot of ['top', 'bottom', 'footwear', 'outerwear']) {
    assert.equal(ids(rank(slot)).includes('c-tote'), false, `${slot} must not offer a bag`);
  }
});

test('only the supplied actor Closet is ever considered', () => {
  // The ranker has no Closet access of its own: an empty projection list can
  // only produce an empty candidate list.
  const result = candidates.rankSlotCandidates({ look: look(), slot: 'top', closetItems: [] });
  assert.equal(result.code, 'NO_CANDIDATES');
  assert.deepEqual(result.candidates, []);
});

// ── Anchor lock ──────────────────────────────────────────────────────────────

test('the anchor slot is LOCKED and offers no candidates', () => {
  const result = rank('outerwear', { anchorClosetItemId: 'c-blazer' });
  assert.equal(result.code, 'ANCHOR_LOCKED');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.currentClosetItemId, 'c-blazer');
});

test('the anchor is never offered as a candidate for any other slot', () => {
  for (const slot of ['top', 'bottom', 'footwear']) {
    const result = rank(slot, { anchorClosetItemId: 'c-blazer' });
    assert.equal(ids(result).includes('c-blazer'), false);
  }
});

test('a non-anchor slot stays editable while the anchor is set', () => {
  const result = rank('top', { anchorClosetItemId: 'c-blazer' });
  assert.equal(result.code, 'READY');
  assert.ok(result.candidates.length > 0);
});

// ── Missing-slot fill ────────────────────────────────────────────────────────

test('an explicitly missing slot can be filled', () => {
  const partial = effective.projectEffectiveLook(
    {
      lookId: 'drlook_1',
      sessionId: 'drsession_1',
      items: [
        { slot: 'top', closetItemId: 'c-shirt' },
        { slot: 'bottom', closetItemId: 'c-trousers' },
      ],
      completeness: 'partial',
      missingSlots: ['footwear'],
      labelCodes: [],
      rank: 0,
    },
    [],
  ).look;
  const result = candidates.rankSlotCandidates({
    look: partial,
    slot: 'footwear',
    closetItems: CLOSET,
  });
  assert.equal(result.code, 'READY');
  assert.equal(result.fills, true);
  assert.equal(result.currentClosetItemId, null);
  assert.deepEqual(ids(result).sort(), ['c-boots', 'c-loafers', 'c-sneakers']);
});

test('a slot that is neither occupied nor missing is not editable', () => {
  // `accessory` is absent from this look and was never reported missing.
  const result = rank('accessory');
  assert.equal(result.code, 'SLOT_NOT_EDITABLE');
  assert.deepEqual(result.candidates, []);
});

// ── Inherited-classifier guard ───────────────────────────────────────────────

test('a title-only false positive is refused when structured taxonomy exists', () => {
  // 'Spring capsule' hits the inherited substring keyword 'cap'. With real
  // structured taxonomy on the record, a title-derived match is not trusted for
  // a swap — and the shared free-tier classifier is left untouched.
  const sneaky = projection.getClosetItemProjection({
    id: 'c-sneaky',
    title: 'Spring capsule',
    category: 'Tops',
    imageUri: 'file:///x.jpg',
  });
  const result = candidates.rankSlotCandidates({
    look: look(),
    slot: 'accessory',
    closetItems: [...CLOSET, sneaky],
  });
  assert.equal(ids(result).includes('c-sneaky'), false);
});

test('a genuine pre-taxonomy record can still match on its title', () => {
  const legacy = projection.getClosetItemProjection({
    id: 'c-legacy',
    title: 'Navy Boots',
    imageUri: 'file:///x.jpg',
  });
  assert.equal(legacy.taxonomyUnknown, true);
  const result = candidates.rankSlotCandidates({
    look: look(),
    slot: 'footwear',
    closetItems: [...CLOSET, legacy],
  });
  assert.equal(ids(result).includes('c-legacy'), true);
});

// ── Ranking ──────────────────────────────────────────────────────────────────

test('ordering is deterministic and independent of Closet array order', () => {
  const forward = candidates.rankSlotCandidates({ look: look(), slot: 'footwear', closetItems: CLOSET });
  const reversed = candidates.rankSlotCandidates({
    look: look(),
    slot: 'footwear',
    closetItems: [...CLOSET].reverse(),
  });
  assert.deepEqual(ids(forward), ids(reversed));
});

test('identical scores resolve by closetItemId ascending', () => {
  const closet = [
    item('c-shirt', 'shirt'),
    item('c-trousers', 'trousers'),
    item('c-loafers', 'loafers'),
    item('zz-top', 'shirt', { primaryColor: 'black' }),
    item('aa-top', 'shirt', { primaryColor: 'black' }),
  ];
  const result = candidates.rankSlotCandidates({ look: look(), slot: 'top', closetItems: closet });
  assert.deepEqual(ids(result), ['aa-top', 'zz-top']);
});

test('occasion ranks candidates without excluding any', () => {
  const evening = candidates.rankSlotCandidates({
    look: look(),
    slot: 'footwear',
    closetItems: CLOSET,
    occasion: 'Dinner',
  });
  const casual = candidates.rankSlotCandidates({
    look: look(),
    slot: 'footwear',
    closetItems: CLOSET,
    occasion: 'Weekend',
  });
  assert.equal(evening.candidates.length, casual.candidates.length, 'nothing is excluded');
  assert.equal(casual.candidates[0].closetItemId, 'c-sneakers', 'casual prefers sneakers');
});

test('an unknown occasion ranks neutrally and still returns candidates', () => {
  const result = candidates.rankSlotCandidates({
    look: look(),
    slot: 'top',
    closetItems: CLOSET,
    occasion: 'Gallery opening',
  });
  assert.equal(result.code, 'READY');
  assert.ok(result.candidates.length > 0);
});

test('an unknown colour neither excludes nor crashes', () => {
  const colourless = item('c-nocolour', 'shirt', { primaryColor: null });
  const result = candidates.rankSlotCandidates({
    look: look(),
    slot: 'top',
    closetItems: [...CLOSET, colourless],
  });
  assert.equal(ids(result).includes('c-nocolour'), true);
});

test('filling a missing slot outranks a mere replacement', () => {
  const partial = effective.projectEffectiveLook(
    {
      lookId: 'drlook_1',
      sessionId: 'drsession_1',
      items: [{ slot: 'top', closetItemId: 'c-shirt' }],
      completeness: 'partial',
      missingSlots: ['bottom', 'footwear'],
      labelCodes: [],
      rank: 0,
    },
    [],
  ).look;
  const result = candidates.rankSlotCandidates({
    look: partial,
    slot: 'footwear',
    closetItems: CLOSET,
  });
  assert.equal(result.fills, true);
  assert.ok(result.candidates[0].score >= 100, 'completeness impact dominates');
});

// ── Bounds and performance ───────────────────────────────────────────────────

function syntheticCloset(size) {
  const out = [
    item('c-shirt', 'shirt'),
    item('c-trousers', 'trousers'),
    item('c-loafers', 'loafers'),
    item('c-blazer', 'blazer'),
  ];
  for (let i = 0; i < size; i += 1) {
    out.push(
      item(`gen_${String(i).padStart(4, '0')}`, 'shirt', {
        primaryColor: ['black', 'white', 'navy', 'red'][i % 4],
      }),
    );
  }
  return out;
}

test('no more than 20 candidates are ever returned', () => {
  const result = candidates.rankSlotCandidates({
    look: look(),
    slot: 'top',
    closetItems: syntheticCloset(300),
  });
  assert.equal(result.candidates.length, 20);
  assert.ok(result.eligible > 20, 'the cap is applied after ranking, not instead of it');
});

test('the cap is applied AFTER deterministic ordering', () => {
  const closet = syntheticCloset(300);
  const forward = candidates.rankSlotCandidates({ look: look(), slot: 'top', closetItems: closet });
  const reversed = candidates.rankSlotCandidates({
    look: look(),
    slot: 'top',
    closetItems: [...closet].reverse(),
  });
  assert.deepEqual(ids(forward), ids(reversed), 'the same 20 in the same order');
});

test('PERFORMANCE EVIDENCE: candidate ranking by Closet size', () => {
  const measurements = [];
  for (const size of [25, 100, 250]) {
    const closet = syntheticCloset(size);
    const target = look();
    const start = process.hrtime.bigint();
    const result = candidates.rankSlotCandidates({
      look: target,
      slot: 'top',
      closetItems: closet,
      occasion: 'Work',
    });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    measurements.push({
      closetSize: closet.length,
      eligible: result.eligible,
      effectiveLookItems: target.items.length,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      returned: result.candidates.length,
    });
    assert.ok(result.candidates.length <= 20);
  }
  console.log('    candidate ranking:', JSON.stringify(measurements));
  for (const measurement of measurements) {
    assert.ok(measurement.elapsedMs < 2000, `slow at ${measurement.closetSize}: ${measurement.elapsedMs}ms`);
  }
});

test('ranking never invokes the Phase 2 composition search', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCandidates.ts'),
    'utf8',
  );
  assert.equal(source.includes('composePrivateOutfits'), false, 'no full re-composition');
  assert.equal(source.includes('COMPOSER_LIMITS'), false, 'no beam search');
  // It DOES reuse the pure scoring primitives, which is the intended reuse.
  assert.match(source, /scoreColorPair|occasionGroupFor/);
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('ranking mutates neither the Closet nor the look', () => {
  const closet = CLOSET.map((entry) => ({ ...entry }));
  const target = look();
  const closetBefore = JSON.stringify(closet);
  const lookBefore = JSON.stringify(target);
  candidates.rankSlotCandidates({
    look: target,
    slot: 'top',
    closetItems: closet,
    occasion: 'Work',
    anchorClosetItemId: 'c-blazer',
  });
  assert.equal(JSON.stringify(closet), closetBefore);
  assert.equal(JSON.stringify(target), lookBefore);
});

test('no module-level mutable state leaks between rankings', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCandidates.ts'),
    'utf8',
  );
  // A shared resolver would make two concurrent rankings see each other's Closet.
  assert.equal(/^let [a-zA-Z]/m.test(source), false, 'no module-level mutable binding');
});

test('the ranker performs no I/O and makes no remote call', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCandidates.ts'),
    'utf8',
  );
  const imports = source.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of ['expo-file-system', 'supabase', 'react-native', 'closetLibrary', 'styleOutfits']) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}`);
    }
  }
  assert.equal(/fetch\(|\.invoke\(|FileSystem\./.test(source), false);
});

// ── Re-validation ────────────────────────────────────────────────────────────

test('eligibility is re-provable immediately before an apply', () => {
  assert.equal(
    candidates.isCandidateStillEligible({
      look: look(),
      slot: 'top',
      candidateClosetItemId: 'c-knit',
      closetItems: CLOSET,
    }),
    true,
  );
  // The garment has left the Closet since the list was built.
  assert.equal(
    candidates.isCandidateStillEligible({
      look: look(),
      slot: 'top',
      candidateClosetItemId: 'c-knit',
      closetItems: CLOSET.filter((entry) => entry.id !== 'c-knit'),
    }),
    false,
  );
  // The anchor can never be re-validated into a swap.
  assert.equal(
    candidates.isCandidateStillEligible({
      look: look(),
      slot: 'outerwear',
      candidateClosetItemId: 'c-coat',
      closetItems: CLOSET,
      anchorClosetItemId: 'c-blazer',
    }),
    false,
  );
});

test('a stale actor is refused before any work', () => {
  const result = candidates.rankSlotCandidates({
    look: look(),
    slot: 'top',
    closetItems: CLOSET,
    isActorCurrent: () => false,
  });
  assert.equal(result.code, 'ACTOR_CHANGED');
  assert.deepEqual(result.candidates, []);
});

test('a Closet load failure is not reported as "no candidates"', () => {
  const result = candidates.rankSlotCandidates({
    look: look(),
    slot: 'top',
    closetItems: [],
    closetOk: false,
  });
  assert.equal(result.code, 'CLOSET_LOAD_FAILED');
  assert.notEqual(result.code, 'NO_CANDIDATES');
});

test('malformed input fails closed', () => {
  assert.equal(candidates.rankSlotCandidates({}).code, 'INVALID_INPUT');
  assert.equal(
    candidates.rankSlotCandidates({ look: null, slot: 'top', closetItems: [] }).code,
    'INVALID_INPUT',
  );
});
