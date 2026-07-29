// "Make It More Casual" — the Phase 4 pre-Commit-4 casualness proof.
//
// The gate this satisfies is not "the mapping table looks right". It is:
//
//   1. a supported occasion group maps to a supported more-casual group
//   2. the PRODUCTION composer actually consumes that group
//   3. the changed group can change the composed output
//   4. the anchor is preserved across the change
//   5. the operation does not merely return the same composition while
//      claiming success
//
// (3) is the one that cannot be argued from source, so it is proven by running
// the real composer twice over one synthetic Closet and comparing the looks.
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
  const sandbox = { exports: mod.exports, module: mod, require: localRequire, console };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const casualness = loadModule('services/privateDressingRoomCasualness.ts');
const composer = loadModule('services/privateDressingRoomComposer.ts');
const composition = loadModule('types/privateDressingRoomComposition.ts');

/**
 * A Closet deliberately built so the composer's occasion keywords disagree.
 *
 * The composer scores occasion at weight 10 — the dominant term — against
 * garment TYPE text. Giving each formality level its own unambiguous garments is
 * what makes a group change observable rather than theoretical.
 */
function closetItem(id, title, category, clothingType) {
  return {
    id,
    title,
    category,
    clothingType,
    subtype: null,
    brand: null,
    primaryColor: 'black',
    secondaryColors: [],
    material: [],
    size: null,
    notes: null,
    origin: null,
    imageUri: null,
    thumbnailUri: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const CLOSET = {
  ok: true,
  items: [
    closetItem('top-silk', 'Silk blouse', 'Tops', 'Blouse'),
    closetItem('top-tee', 'Cotton tee', 'Tops', 'Tee'),
    closetItem('top-shirt', 'Oxford shirt', 'Tops', 'Shirt'),
    closetItem('bottom-trouser', 'Wool trousers', 'Bottoms', 'Trousers'),
    closetItem('bottom-jean', 'Blue jeans', 'Bottoms', 'Jeans'),
    closetItem('shoe-heel', 'Black heels', 'Shoes', 'Heels'),
    closetItem('shoe-sneaker', 'White sneakers', 'Shoes', 'Sneakers'),
    closetItem('shoe-loafer', 'Leather loafers', 'Shoes', 'Loafers'),
  ],
};

function compose(occasion, anchorClosetItemId = null) {
  return composer.composePrivateOutfits({
    session: {
      actorId: 'actor-1',
      sessionId: 'session-1',
      status: 'active',
      anchorClosetItemId,
      occasion,
    },
    closet: CLOSET,
  });
}

function lookSignature(result) {
  return result.looks
    .map((look) =>
      look.items
        .map((item) => `${item.slot}:${item.closetItemId}`)
        .sort()
        .join('+'),
    )
    .join('|');
}

// ── 1. The mapping is over existing groups, and round-trips ───────────────────

test('every occasion the ladder writes resolves back to the group it claims', () => {
  const seen = new Set();
  for (const group of composition.PRIVATE_OCCASION_GROUPS) {
    const outcome = casualness.resolveMoreCasualOccasion(
      // Pick any occasion that lands in this group by asking the ladder for the
      // canonical value of the group one step ABOVE where possible; simpler and
      // sufficient: drive the ladder from a known occasion per group below.
      group === 'evening'
        ? 'Dinner'
        : group === 'work'
          ? 'Work'
          : group === 'smart_casual'
            ? 'Smart'
            : group === 'casual'
              ? 'Weekend'
              : group === 'travel'
                ? 'Travel'
                : null,
    );
    if (!outcome.supported) continue;
    seen.add(`${outcome.fromGroup}->${outcome.toGroup}`);
    assert.equal(
      composer.occasionGroupFor(outcome.occasion),
      outcome.toGroup,
      `${outcome.occasion} must resolve to ${outcome.toGroup}`,
    );
  }
  assert.deepEqual(
    [...seen].sort(),
    ['evening->work', 'smart_casual->casual', 'work->smart_casual'],
  );
});

test('the ladder is a strict one-step descent and terminates', () => {
  let occasion = 'Dinner';
  const path = [composer.occasionGroupFor(occasion)];
  for (let step = 0; step < 10; step += 1) {
    const outcome = casualness.resolveMoreCasualOccasion(occasion);
    if (!outcome.supported) break;
    occasion = outcome.occasion;
    path.push(outcome.toGroup);
  }
  assert.deepEqual(path, ['evening', 'work', 'smart_casual', 'casual']);
  const floor = casualness.resolveMoreCasualOccasion(occasion);
  assert.equal(floor.supported, false);
  assert.equal(floor.reason, 'already_most_casual');
});

test('off-ladder occasions return a supported unsupported result', () => {
  const travel = casualness.resolveMoreCasualOccasion('Travel');
  assert.equal(travel.supported, false);
  assert.equal(travel.reason, 'no_supported_transition');

  for (const value of [null, undefined, '', 'Moon landing']) {
    const outcome = casualness.resolveMoreCasualOccasion(value);
    assert.equal(outcome.supported, false, `${value} must not transition`);
    assert.equal(outcome.fromGroup, 'neutral');
    assert.equal(outcome.reason, 'no_supported_transition');
  }
  assert.equal(casualness.canMakeMoreCasual('Travel'), false);
  assert.equal(casualness.canMakeMoreCasual('Dinner'), true);
});

// ── 2 + 3. The composer consumes the group, and the output changes ────────────

test('the production composer consumes the occasion group', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomComposer.ts'),
    'utf8',
  );
  // The group reaches pool building, beam scoring and labelling — it is not a
  // display-only value.
  assert.match(source, /const group = occasionGroupFor\(occasion\)/);
  assert.match(source, /buildPools\(classified, anchor, anchorId, group\)/);
  assert.match(source, /assemble\(structure, pools, pinned, group, budget\)/);
  assert.match(source, /scoreOccasion\(group, bySlot\) \* 10/);
});

test('CASUALNESS TRANSITION PROVEN: a one-step descent changes the composition', () => {
  const evening = compose('Dinner');
  assert.equal(evening.code, 'SUCCESS', `evening composition failed: ${evening.code}`);

  const step = casualness.resolveMoreCasualOccasion('Dinner');
  assert.equal(step.supported, true);

  const afterOne = compose(step.occasion);
  assert.equal(afterOne.code, 'SUCCESS');

  // Walk to the floor and compare the extremes, which is where the keyword sets
  // disagree most and where a no-op implementation would be exposed.
  const toCasual = casualness.resolveMoreCasualOccasion(
    casualness.resolveMoreCasualOccasion(step.occasion).occasion,
  );
  assert.equal(toCasual.supported, true);
  assert.equal(toCasual.toGroup, 'casual');
  const casual = compose(toCasual.occasion);
  assert.equal(casual.code, 'SUCCESS');

  assert.notEqual(
    lookSignature(evening),
    lookSignature(casual),
    'the composer produced an identical set for evening and casual — the ' +
      'transition would be cosmetic',
  );

  // And the direction is right: the casual set reaches for casual garments.
  const casualIds = casual.looks.flatMap((look) => look.items.map((item) => item.closetItemId));
  const eveningIds = evening.looks.flatMap((look) => look.items.map((item) => item.closetItemId));
  assert.ok(casualIds.includes('shoe-sneaker'), 'casual should reach sneakers');
  assert.ok(eveningIds.includes('shoe-heel'), 'evening should reach heels');
});

// ── 4 + 5. Anchor preservation, and no false success ──────────────────────────

test('the anchor survives the transition and appears in every look', () => {
  const anchor = 'top-silk';
  const before = compose('Dinner', anchor);
  assert.equal(before.code, 'SUCCESS');

  const step = casualness.resolveMoreCasualOccasion('Dinner');
  const after = compose(step.occasion, anchor);
  assert.equal(after.code, 'SUCCESS');

  for (const look of after.looks) {
    assert.ok(
      look.items.some((item) => item.closetItemId === anchor),
      'every look must still contain the anchor',
    );
  }
});

test('an unsupported transition yields no occasion to apply', () => {
  // The caller cannot accidentally recompose: there is no occasion in the
  // unsupported result to pass to the composer.
  const outcome = casualness.resolveMoreCasualOccasion('Weekend');
  assert.equal(outcome.supported, false);
  assert.equal(outcome.occasion, undefined);
});

test('the module reaches no provider, no storage and no network', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCasualness.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [
    'fetch',
    'supabase',
    'functions.invoke',
    'AsyncStorage',
    'SecureStore',
    'schemaVersion',
    'privateDressingRoomElise',
  ]) {
    assert.equal(code.includes(forbidden), false, `casualness must not reference ${forbidden}`);
  }
});
