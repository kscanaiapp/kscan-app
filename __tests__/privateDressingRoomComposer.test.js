// Deterministic private Dressing Room outfit composer (Phase 2, Stage 4).
//
// The composer is PURE, so these exercise it directly with synthetic Closet
// records — no filesystem, no renderer, no network.
//
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
      return { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 17) % 256) };
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

const composer = loadModule('services/privateDressingRoomComposer.ts');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function item(id, subtype, extra = {}) {
  return {
    id,
    title: id,
    subtype,
    category: null,
    clothingType: null,
    primaryColor: 'black',
    secondaryColors: [],
    material: [],
    imageUri: `file:///doc/kscan_closet/images/${id}.jpg`,
    thumbnailUri: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function closet(items) {
  return { ok: true, items };
}

function session(overrides = {}) {
  return {
    actorId: 'user-a',
    sessionId: 'drsession_1',
    status: 'active',
    anchorClosetItemId: null,
    occasion: null,
    ...overrides,
  };
}

/** A wardrobe that can build several genuinely different complete outfits. */
function richCloset() {
  return [
    item('blazer', 'blazer', { primaryColor: 'black' }),
    item('coat', 'coat', { primaryColor: 'camel' }),
    item('shirt', 'shirt', { primaryColor: 'white' }),
    item('knit', 'sweater', { primaryColor: 'navy' }),
    item('blouse', 'blouse', { primaryColor: 'ivory' }),
    item('trousers', 'trousers', { primaryColor: 'charcoal' }),
    item('jeans', 'jeans', { primaryColor: 'denim' }),
    item('skirt', 'skirt', { primaryColor: 'black' }),
    item('dress', 'dress', { primaryColor: 'navy' }),
    item('loafers', 'loafers', { primaryColor: 'brown' }),
    item('boots', 'boots', { primaryColor: 'black' }),
    item('sneakers', 'sneakers', { primaryColor: 'white' }),
    item('scarf', 'scarf', { primaryColor: 'grey' }),
  ];
}

function itemIds(look) {
  return look.items.map((entry) => entry.closetItemId).sort();
}

function slotsOf(look) {
  return look.items.map((entry) => entry.slot);
}

// ── Trigger behaviour ────────────────────────────────────────────────────────

test('anchor only composes automatically', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SUCCESS');
  assert.ok(result.looks.length >= 1);
});

test('occasion only composes automatically', () => {
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Dinner' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SUCCESS');
  assert.ok(result.looks.length >= 1);
});

test('anchor plus occasion composes automatically', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer', occasion: 'Work' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SUCCESS');
});

test('neither anchor nor occasion does not compose', () => {
  const result = composer.composePrivateOutfits({
    session: session(),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SESSION_CONTEXT_REQUIRED');
  assert.deepEqual(result.looks, []);
});

test('a whitespace-only occasion is not context', () => {
  const result = composer.composePrivateOutfits({
    session: session({ occasion: '   ' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SESSION_CONTEXT_REQUIRED');
});

test('a non-active session does not compose', () => {
  const result = composer.composePrivateOutfits({
    session: session({ status: 'discarded', occasion: 'Work' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SESSION_CONTEXT_REQUIRED');
});

// ── Typed failures ───────────────────────────────────────────────────────────

test('a Closet load failure is never reported as an empty Closet', () => {
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Work' }),
    closet: { ok: false, items: [], code: 'READ_FAILED' },
  });
  assert.equal(result.code, 'CLOSET_LOAD_FAILED');
  assert.notEqual(result.code, 'CLOSET_EMPTY');
});

test('an empty Closet is reported as empty', () => {
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Work' }),
    closet: closet([]),
  });
  assert.equal(result.code, 'CLOSET_EMPTY');
});

test('a missing anchor is reported without inventing metadata', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'deleted-item' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'ANCHOR_MISSING');
  assert.deepEqual(result.looks, []);
});

test('an anchor with no outfit role is unsupported', () => {
  const items = [...richCloset(), item('tote', 'tote bag')];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'tote' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'UNSUPPORTED_ANCHOR');
});

test('a stale actor is refused before any work', () => {
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Work' }),
    closet: closet(richCloset()),
    isActorCurrent: () => false,
  });
  assert.equal(result.code, 'ACTOR_CHANGED');
});

test('malformed input fails closed', () => {
  assert.equal(composer.composePrivateOutfits({}).code, 'INVALID_INPUT');
  assert.equal(
    composer.composePrivateOutfits({ session: session({ occasion: 'x' }), closet: null }).code,
    'INVALID_INPUT',
  );
  assert.equal(
    composer.composePrivateOutfits({ session: { sessionId: '' }, closet: closet([]) }).code,
    'INVALID_INPUT',
  );
});

test('a Closet of only unclassifiable items yields insufficient items', () => {
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Work' }),
    closet: closet([item('x', 'Zephyr'), item('y', 'Quux')]),
  });
  assert.equal(result.code, 'INSUFFICIENT_ITEMS');
});

// ── Anchor behaviour by slot ─────────────────────────────────────────────────

const ANCHOR_CASES = [
  ['shirt', 'top'],
  ['trousers', 'bottom'],
  ['dress', 'dress'],
  ['blazer', 'outerwear'],
  ['loafers', 'footwear'],
  ['scarf', 'accessory'],
];

for (const [anchorId, expectedSlot] of ANCHOR_CASES) {
  test(`a ${expectedSlot} anchor appears in every look, exactly once`, () => {
    const result = composer.composePrivateOutfits({
      session: session({ anchorClosetItemId: anchorId }),
      closet: closet(richCloset()),
    });
    assert.equal(result.code, 'SUCCESS', `${anchorId}: ${result.code}`);
    assert.ok(result.looks.length >= 1);
    for (const look of result.looks) {
      const occurrences = look.items.filter((entry) => entry.closetItemId === anchorId);
      assert.equal(occurrences.length, 1, `${anchorId} must appear exactly once`);
      assert.equal(occurrences[0].slot, expectedSlot, `${anchorId} keeps its slot`);
    }
  });
}

test('a dress anchor replaces top and bottom', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'dress' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SUCCESS');
  for (const look of result.looks) {
    const slots = slotsOf(look);
    assert.ok(slots.includes('dress'));
    assert.equal(slots.includes('top'), false, 'a one-piece look has no top');
    assert.equal(slots.includes('bottom'), false, 'a one-piece look has no bottom');
    assert.ok(slots.includes('footwear'));
  }
});

test('a secondary anchor slot is tried when the primary yields nothing complete', () => {
  // A cardigan anchor in a wardrobe with NO other top. Held in its primary
  // `outerwear` role the separates structure can never be completed, because
  // the top slot has no candidate. Its verified secondary role is `top`, where
  // a complete outfit does exist — so the retry finds it rather than settling
  // for the partial the primary slot produced.
  const items = [
    item('cardigan', 'cardigan', { primaryColor: 'camel' }),
    item('trousers', 'trousers', { primaryColor: 'navy' }),
    item('loafers', 'loafers', { primaryColor: 'brown' }),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'cardigan' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
  assert.equal(result.anchorSlot, 'top', 'the verified secondary slot was used');
  for (const look of result.looks) {
    assert.equal(look.completeness, 'complete');
    const anchorEntry = look.items.find((entry) => entry.closetItemId === 'cardigan');
    assert.ok(anchorEntry, 'the anchor survives the retry');
    assert.equal(anchorEntry.slot, 'top');
  }
});

test('a dress anchor stays a one-piece whenever shoes exist', () => {
  // The dress -> top secondary is only ever reached when the primary role
  // cannot complete, and a one-piece needs nothing but footwear.
  const items = [
    item('dress', 'dress'),
    item('trousers', 'trousers'),
    item('loafers', 'loafers'),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'dress' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
  assert.equal(result.anchorSlot, 'dress');
});

test('an anchor is never dropped in favour of a better outfit without it', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'sneakers', occasion: 'Dinner' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SUCCESS');
  for (const look of result.looks) {
    assert.ok(
      look.items.some((entry) => entry.closetItemId === 'sneakers'),
      'the anchor survives even when the occasion would prefer otherwise',
    );
  }
});

// ── Structure and completeness ───────────────────────────────────────────────

test('complete looks satisfy a full core structure', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'shirt' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SUCCESS');
  for (const look of result.looks) {
    assert.equal(look.completeness, 'complete');
    assert.deepEqual(look.missingSlots, []);
    const slots = new Set(slotsOf(look));
    const separates = slots.has('top') && slots.has('bottom') && slots.has('footwear');
    const onePiece = slots.has('dress') && slots.has('footwear');
    assert.ok(separates || onePiece, `unexpected structure: ${[...slots].join(',')}`);
  }
});

test('optional slots are never forced', () => {
  const items = [
    item('shirt', 'shirt'),
    item('trousers', 'trousers'),
    item('loafers', 'loafers'),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'shirt' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
  assert.equal(result.looks[0].completeness, 'complete');
  assert.deepEqual(result.looks[0].missingSlots, []);
});

test('exactly one complete look is returned as exactly one look', () => {
  const items = [
    item('shirt', 'shirt'),
    item('trousers', 'trousers'),
    item('loafers', 'loafers'),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'shirt' }),
    closet: closet(items),
  });
  assert.equal(result.looks.length, 1, 'no padding to reach three');
  assert.equal(result.looks[0].completeness, 'complete');
});

test('exactly two complete looks are returned as exactly two looks', () => {
  const items = [
    item('shirt', 'shirt'),
    item('trousers', 'trousers'),
    item('jeans', 'jeans'),
    item('loafers', 'loafers'),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'shirt' }),
    closet: closet(items),
  });
  assert.equal(result.looks.length, 2);
  for (const look of result.looks) assert.equal(look.completeness, 'complete');
});

test('at most three looks are ever returned', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer' }),
    closet: closet(richCloset()),
  });
  assert.ok(result.looks.length <= 3);
});

test('NO PADDING: a partial look never accompanies a complete one', () => {
  const items = [
    item('shirt', 'shirt'),
    item('trousers', 'trousers'),
    item('loafers', 'loafers'),
    item('blazer', 'blazer'),
    item('scarf', 'scarf'),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'shirt' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
  for (const look of result.looks) {
    assert.equal(look.completeness, 'complete', 'a degraded variant must never be offered');
  }
});

// ── Partial looks ────────────────────────────────────────────────────────────

test('partial looks appear only when no complete look exists, and say what is missing', () => {
  const items = [item('shirt', 'shirt'), item('trousers', 'trousers')];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'shirt' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS_PARTIAL');
  assert.ok(result.looks.length >= 1);
  for (const look of result.looks) {
    assert.equal(look.completeness, 'partial');
    assert.deepEqual(look.missingSlots, ['footwear']);
    assert.ok(look.labelCodes.includes('PARTIAL_LOOK'));
  }
});

test('a partial look is maximal — it uses every compatible garment available', () => {
  const items = [item('shirt', 'shirt'), item('trousers', 'trousers'), item('blazer', 'blazer')];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'shirt' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS_PARTIAL');
  const ids = itemIds(result.looks[0]);
  assert.ok(ids.includes('shirt'));
  assert.ok(ids.includes('trousers'));
});

test('missing slots are truthful for a shoes-only wardrobe', () => {
  const items = [item('loafers', 'loafers'), item('scarf', 'scarf')];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'loafers' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS_PARTIAL');
  const missing = result.looks[0].missingSlots;
  assert.ok(missing.includes('top'));
  assert.ok(missing.includes('bottom'));
  assert.equal(missing.includes('footwear'), false, 'shoes are present');
});

test('a slot is never both filled and missing', () => {
  const items = [item('shirt', 'shirt'), item('trousers', 'trousers')];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'shirt' }),
    closet: closet(items),
  });
  for (const look of result.looks) {
    const filled = new Set(slotsOf(look));
    for (const slot of look.missingSlots) assert.equal(filled.has(slot), false);
  }
});

// ── Distinctness ─────────────────────────────────────────────────────────────

test('no two looks share an identical garment set', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer' }),
    closet: closet(richCloset()),
  });
  const keys = result.looks.map((look) => itemIds(look).join('+'));
  assert.equal(new Set(keys).size, keys.length);
});

test('looks differ by at least one non-anchor garment', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer' }),
    closet: closet(richCloset()),
  });
  const sets = result.looks.map(
    (look) => new Set(itemIds(look).filter((id) => id !== 'blazer')),
  );
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const differs = [...sets[i]].some((id) => !sets[j].has(id)) || [...sets[j]].some((id) => !sets[i].has(id));
      assert.ok(differs, 'two looks differed only by the anchor');
    }
  }
});

test('no item fills two slots in one look', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer' }),
    closet: closet(richCloset()),
  });
  for (const look of result.looks) {
    const ids = look.items.map((entry) => entry.closetItemId);
    assert.equal(new Set(ids).size, ids.length);
    const slots = slotsOf(look);
    assert.equal(new Set(slots).size, slots.length);
  }
});

test('ranks are unique and sequential from zero', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer' }),
    closet: closet(richCloset()),
  });
  assert.deepEqual(
    result.looks.map((look) => look.rank),
    result.looks.map((_, index) => index),
  );
});

// ── Determinism ──────────────────────────────────────────────────────────────

test('identical input produces identical looks, ranking and labels', () => {
  const run = () =>
    composer.composePrivateOutfits({
      session: session({ anchorClosetItemId: 'blazer', occasion: 'Work' }),
      closet: closet(richCloset()),
    });
  const a = run();
  const b = run();
  assert.equal(a.code, b.code);
  assert.equal(a.anchorSlot, b.anchorSlot);
  assert.deepEqual(
    a.looks.map((look) => ({ ids: itemIds(look), rank: look.rank, labels: look.labelCodes, slots: slotsOf(look) })),
    b.looks.map((look) => ({ ids: itemIds(look), rank: look.rank, labels: look.labelCodes, slots: slotsOf(look) })),
  );
});

test('input array order does not change the result', () => {
  const forward = richCloset();
  const reversed = [...forward].reverse();
  const run = (items) =>
    composer.composePrivateOutfits({
      session: session({ anchorClosetItemId: 'blazer', occasion: 'Work' }),
      closet: closet(items),
    });
  assert.deepEqual(
    run(forward).looks.map((look) => itemIds(look)),
    run(reversed).looks.map((look) => itemIds(look)),
    'candidate ordering must not depend on input order',
  );
});

test('items with identical scores resolve by closetItemId', () => {
  // Two interchangeable tops; the lexicographically smaller id must win.
  const items = [
    item('top_zzz', 'shirt', { primaryColor: 'white' }),
    item('top_aaa', 'shirt', { primaryColor: 'white' }),
    item('trousers', 'trousers', { primaryColor: 'black' }),
    item('loafers', 'loafers', { primaryColor: 'black' }),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'trousers' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
  assert.ok(itemIds(result.looks[0]).includes('top_aaa'));
});

// ── Colour model ─────────────────────────────────────────────────────────────

test('colour pair scoring is bounded and never negative', () => {
  const cases = [
    ['black', 'white', 3],
    ['black', 'red', 2],
    ['red', 'red', 2],
    ['red', 'pink', 1],
    ['blue', 'orange', 1],
    ['red', 'green', 0],
    [null, 'red', 0],
    ['red', undefined, 0],
    ['Zephyr', 'red', 0],
  ];
  for (const [a, b, expected] of cases) {
    const score = composer.scoreColorPair(a, b);
    assert.equal(score, expected, `${a} + ${b}`);
    assert.ok(score >= 0);
  }
});

test('an unknown colour is unknown, not confidently neutral', () => {
  assert.equal(composer.classifyColor(null).kind, 'unknown');
  assert.equal(composer.classifyColor('').kind, 'unknown');
  assert.equal(composer.classifyColor('black').kind, 'neutral');
  assert.equal(composer.classifyColor('red').kind, 'family');
});

test('a bold colour combination is ranked, never rejected', () => {
  const items = [
    item('redtop', 'shirt', { primaryColor: 'red' }),
    item('greenbottom', 'trousers', { primaryColor: 'green' }),
    item('shoes', 'loafers', { primaryColor: 'orange' }),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'redtop' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS', 'colour must not disqualify a valid outfit');
  assert.equal(result.looks[0].completeness, 'complete');
});

test('monochrome and neutral wardrobes compose', () => {
  const items = [
    item('t', 'shirt', { primaryColor: 'black' }),
    item('b', 'trousers', { primaryColor: 'black' }),
    item('s', 'boots', { primaryColor: 'black' }),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Work' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
});

test('items with no colour still compose', () => {
  const items = [
    item('t', 'shirt', { primaryColor: null }),
    item('b', 'trousers', { primaryColor: null }),
    item('s', 'boots', { primaryColor: null }),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Work' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
});

test('colour cannot outrank completeness', () => {
  // A perfectly-matched incomplete pair against a mismatched complete outfit.
  const items = [
    item('t', 'shirt', { primaryColor: 'red' }),
    item('b', 'trousers', { primaryColor: 'green' }),
    item('s', 'boots', { primaryColor: 'orange' }),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 't' }),
    closet: closet(items),
  });
  assert.equal(result.looks[0].completeness, 'complete');
});

// ── Occasion model ───────────────────────────────────────────────────────────

test('verified occasion values map to formality groups', () => {
  const cases = [
    ['Casual', 'casual'],
    ['Weekend', 'casual'],
    ['Work', 'work'],
    ['Office', 'work'],
    ['Date', 'evening'],
    ['Dinner', 'evening'],
    ['Event', 'evening'],
    ['Travel', 'travel'],
    ['Other', 'neutral'],
    ['Smart', 'smart_casual'],
  ];
  for (const [value, group] of cases) {
    assert.equal(composer.occasionGroupFor(value), group, value);
  }
});

test('unknown occasion text ranks as neutral and is not replaced', () => {
  assert.equal(composer.occasionGroupFor('Gallery opening'), 'neutral');
  assert.equal(composer.occasionGroupFor(''), 'neutral');
  assert.equal(composer.occasionGroupFor(null), 'neutral');
});

test('a multi-word occasion matches the FIRST contained verified token', () => {
  // First-token-wins is deliberate and deterministic. Ranking "work dinner" as
  // evening rather than work would need a priority order among formality
  // groups, and that is a dress-code opinion Phase 2 does not encode.
  assert.equal(composer.occasionGroupFor('work dinner'), 'work');
  assert.equal(composer.occasionGroupFor('dinner with work friends'), 'evening');
  assert.equal(composer.occasionGroupFor('  WEEKEND trip '), 'casual');
  assert.equal(composer.occasionGroupFor('gallery opening'), 'neutral');
});

test('occasion ranks but never excludes', () => {
  const items = [
    item('t', 'shirt'),
    item('b', 'trousers'),
    item('s', 'sneakers'),
  ];
  // Sneakers for an evening occasion: ranked lower, still offered.
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Dinner' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
  assert.equal(result.looks[0].completeness, 'complete');
});

test('an evening occasion prefers a one-piece when both are available', () => {
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Dinner' }),
    closet: closet(richCloset()),
  });
  assert.equal(result.code, 'SUCCESS');
  const first = result.looks[0];
  assert.ok(
    slotsOf(first).includes('dress') || first.labelCodes.includes('EVENING_OPTION'),
    'evening ranking should surface a dress or an evening-labelled look first',
  );
});

// ── Material ─────────────────────────────────────────────────────────────────

test('missing material is neutral, never a penalty', () => {
  const items = [
    item('t', 'shirt', { material: [] }),
    item('b', 'trousers', { material: [] }),
    item('s', 'boots', { material: [] }),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ occasion: 'Work' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
});

test('material never rejects a look', () => {
  const items = [
    item('t', 'sweater', { material: ['wool'] }),
    item('o', 'coat', { material: ['wool'] }),
    item('b', 'trousers', { material: ['wool'] }),
    item('s', 'boots', { material: ['leather'] }),
  ];
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'o' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
});

// ── Bounds ───────────────────────────────────────────────────────────────────

test('candidate caps are declared at or below the mandated maxima', () => {
  const caps = composer.COMPOSER_LIMITS.candidateCaps;
  const maxima = { top: 20, bottom: 20, dress: 15, outerwear: 12, footwear: 15, accessory: 10 };
  for (const [slot, max] of Object.entries(maxima)) {
    assert.ok(caps[slot] <= max, `${slot} cap ${caps[slot]} exceeds ${max}`);
    assert.ok(caps[slot] > 0);
  }
  assert.equal(composer.COMPOSER_LIMITS.beamWidth, 100);
  assert.equal(composer.COMPOSER_LIMITS.maxScoredStates, 2500);
  assert.equal(composer.COMPOSER_LIMITS.maxLooks, 3);
});

function syntheticCloset(size) {
  const kinds = [
    ['shirt', 'top'],
    ['trousers', 'bottom'],
    ['loafers', 'footwear'],
    ['blazer', 'outerwear'],
    ['dress', 'dress'],
    ['scarf', 'accessory'],
  ];
  const colors = ['black', 'white', 'navy', 'red', 'green', 'camel'];
  const items = [];
  for (let i = 0; i < size; i += 1) {
    const [subtype] = kinds[i % kinds.length];
    items.push(
      item(`item_${String(i).padStart(4, '0')}`, subtype, {
        primaryColor: colors[i % colors.length],
      }),
    );
  }
  return items;
}

test('the scored-state budget is never exceeded, at any Closet size', () => {
  for (const size of [25, 100, 250]) {
    const result = composer.composePrivateOutfits({
      session: session({ occasion: 'Work' }),
      closet: closet(syntheticCloset(size)),
    });
    assert.ok(
      result.scoredStates <= composer.COMPOSER_LIMITS.maxScoredStates,
      `size ${size} scored ${result.scoredStates}`,
    );
    assert.ok(result.looks.length <= 3);
  }
});

test('a large Closet still composes and stays bounded with an anchor', () => {
  const items = syntheticCloset(250);
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: items[0].id, occasion: 'Dinner' }),
    closet: closet(items),
  });
  assert.equal(result.code, 'SUCCESS');
  assert.ok(result.scoredStates <= composer.COMPOSER_LIMITS.maxScoredStates);
});

test('PERFORMANCE EVIDENCE: composer-only elapsed time by Closet size', () => {
  // Measures the pure composer only — no filesystem, no rendering, no setup.
  // The HARD gate is the state budget asserted above; these numbers are
  // recorded as evidence and flagged if a run looks unexpectedly slow.
  const measurements = [];
  for (const size of [25, 100, 250]) {
    const items = syntheticCloset(size);
    const start = process.hrtime.bigint();
    const result = composer.composePrivateOutfits({
      session: session({ anchorClosetItemId: items[0].id, occasion: 'Work' }),
      closet: closet(items),
    });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    measurements.push({ size, elapsedMs: Number(elapsedMs.toFixed(2)), states: result.scoredStates });
    assert.ok(result.scoredStates <= composer.COMPOSER_LIMITS.maxScoredStates);
  }
  console.log('    composer performance:', JSON.stringify(measurements));
  for (const measurement of measurements) {
    assert.ok(
      measurement.elapsedMs < 5000,
      `size ${measurement.size} took ${measurement.elapsedMs}ms — investigate`,
    );
  }
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('the composer never mutates the Closet input', () => {
  const items = richCloset();
  const before = JSON.stringify(items);
  composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer', occasion: 'Work' }),
    closet: closet(items),
  });
  assert.equal(JSON.stringify(items), before);
});

test('the composer performs no I/O and makes no remote call', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomComposer.ts'),
    'utf8',
  );
  const imports = source.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of [
      'expo-file-system',
      'supabase',
      'react-native',
      'closetLibrary',
      'styleOutfits',
      'outfitDecisions',
    ]) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}: ${line}`);
    }
  }
  for (const call of ['fetch(', 'invoke(', 'FileSystem.', 'AsyncStorage']) {
    assert.equal(source.includes(call), false, `must not call ${call}`);
  }
});

test('only owned Closet items ever appear in a look', () => {
  const items = richCloset();
  const owned = new Set(items.map((entry) => entry.id));
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer', occasion: 'Work' }),
    closet: closet(items),
  });
  for (const look of result.looks) {
    for (const entry of look.items) {
      assert.ok(owned.has(entry.closetItemId), `${entry.closetItemId} is not an owned garment`);
    }
  }
});

test('a look carries references only — no duplicated garment metadata', () => {
  const result = composer.composePrivateOutfits({
    session: session({ anchorClosetItemId: 'blazer' }),
    closet: closet(richCloset()),
  });
  for (const look of result.looks) {
    for (const entry of look.items) {
      assert.deepEqual(Object.keys(entry).sort(), ['closetItemId', 'slot']);
    }
  }
});
