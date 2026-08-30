/**
 * BUG-15 — the Saved Look surfaces must not speak engineering to shoppers.
 *
 * Two layers of proof, because either alone is weak:
 *
 *  1. the copy module is data, so every string it owns can be walked and
 *     checked against the forbidden vocabulary;
 *  2. the screens are read as SOURCE and every literal that reaches a rendering
 *     position is checked too — because a clean copy module proves nothing if a
 *     screen still renders `slotOwnership.diagnosticReason` or hardcodes a
 *     string beside it. That second check is what the pre-repair code fails.
 *
 * Deliberately NOT a repository-wide ban on "unknown": the resolver's own state
 * is legitimately named `unknown` and the diagnostics legitimately say
 * "normalized taxonomy". Those are internal and are asserted to STAY internal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const cache = new Map();
function loadModule(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
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
    if (!specifier.startsWith('.')) throw new Error(`Unexpected import ${specifier}`);
    let resolved = path.resolve(dirname, specifier);
    for (const ext of ['', '.ts', '.js']) {
      if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
        resolved += ext;
        break;
      }
    }
    return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
  };
  vm.runInThisContext(`(function(exports,module,require){${output}\n})`, { filename })(
    mod.exports,
    mod,
    localRequire,
  );
  cache.set(relPath, mod.exports);
  return mod.exports;
}

const copy = loadModule('services/privateSavedLookCopy.ts');
const ownership = loadModule('services/privateSavedLookOwnership.ts');
const fixtures = loadModule('services/privateSavedLookOwnershipFixtures.ts');

const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

/** The screens a shopper actually reaches from a Saved Look. */
const RENDERED_SCREENS = [
  'app/stylist/saved-looks/index.tsx',
  'app/stylist/saved-looks/[id].tsx',
  'app/stylist/saved-looks/handoff.tsx',
];

/** The exact strings the QA report found on screen. */
const REPORTED_STRINGS = [
  'Ownership unknown',
  'The saved slot lacks enough normalized taxonomy to decide ownership.',
  'The original Closet item still exists in the same semantic slot.',
  'Unknown Product',
];

function offendingPhrases(value) {
  const haystack = String(value).toLowerCase();
  return copy.FORBIDDEN_SHOPPER_PHRASES.filter((phrase) => haystack.includes(phrase));
}

/**
 * Every double/single-quoted literal and template chunk in a source file, minus
 * the things that are addresses rather than words: import specifiers and route
 * paths. It still over-collects (it sees testIDs and style keys), and that is
 * fine — the forbidden list is phrase-shaped, so identifiers do not trip it.
 */
function sourceLiterals(source) {
  const withoutImports = source
    .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?$/gm, '');

  const literals = [];
  const pattern = /'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`]*)`/g;
  let match;
  while ((match = pattern.exec(withoutImports)) !== null) {
    const literal = match[1] ?? match[2] ?? match[3] ?? '';
    // Routes and module paths are addresses, never rendered text.
    if (/^[./]/.test(literal)) continue;
    // Machine identifiers — testIDs, keys, enum values. No shopper reads these,
    // and the resolver's own states are legitimately named this way.
    if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(literal)) continue;
    literals.push(literal);
  }
  return literals;
}

test('every shopper-facing Saved Look string is free of implementation vocabulary', () => {
  for (const value of copy.allSavedLookShopperCopy()) {
    assert.deepEqual(
      offendingPhrases(value),
      [],
      `shopper copy leaks implementation vocabulary: ${JSON.stringify(value)}`,
    );
  }
});

test('every ownership state resolves to shopper copy, with no gaps', () => {
  for (const state of ownership.PRIVATE_OWNERSHIP_STATES) {
    const slotCopy = copy.savedLookSlotCopy(state);
    assert.ok(slotCopy.label.length > 0, `${state} has no label`);
    assert.ok(slotCopy.detail.length > 0, `${state} has no detail`);
    assert.notEqual(
      slotCopy,
      copy.SAVED_LOOK_SLOT_UNAVAILABLE,
      `${state} silently fell through to the unavailable fallback`,
    );
  }
});

test('an unresolvable slot gets the neutral fallback, not a raw state name', () => {
  for (const value of [null, undefined, 'some_future_state']) {
    const slotCopy = copy.savedLookSlotCopy(value);
    assert.equal(slotCopy.label, copy.SAVED_LOOK_SLOT_UNAVAILABLE.label);
    assert.deepEqual(offendingPhrases(slotCopy.label), []);
    assert.deepEqual(offendingPhrases(slotCopy.detail), []);
  }
});

test('no rendered Saved Look screen contains a forbidden literal', () => {
  for (const screen of RENDERED_SCREENS) {
    for (const literal of sourceLiterals(read(screen))) {
      assert.deepEqual(
        offendingPhrases(literal),
        [],
        `${screen} contains a shopper-visible literal with implementation vocabulary: ${JSON.stringify(literal)}`,
      );
    }
  }
});

test('none of the exact strings QA reported survive anywhere in the rendered path', () => {
  for (const screen of RENDERED_SCREENS) {
    const source = read(screen);
    for (const reported of REPORTED_STRINGS) {
      assert.equal(
        source.includes(reported),
        false,
        `${screen} still contains ${JSON.stringify(reported)}`,
      );
    }
  }
});

test('the resolver diagnosis is never rendered by any Saved Look screen', () => {
  for (const screen of RENDERED_SCREENS) {
    const source = read(screen);
    assert.equal(
      /\.diagnosticReason/.test(source),
      false,
      `${screen} renders the internal diagnosis`,
    );
    // The old field name must not come back either.
    assert.equal(/confidenceExplanation/.test(source), false, `${screen} renders the old diagnosis field`);
  }
});

test('the internal diagnosis is still produced, and still says the useful thing', () => {
  // The repair must not have silently deleted the diagnosis: it is what makes a
  // wrong ownership answer debuggable. It just may not be shown.
  const fixture = fixtures.PRIVATE_OWNERSHIP_FIXTURES.find(
    (entry) => entry.expectedState === 'unknown',
  );
  assert.ok(fixture, 'expected an unknown-state fixture');
  const result = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet, {
    loadedForActorId: fixture.actorId,
  });
  assert.match(result.slots[0].diagnosticReason, /normalized taxonomy/i);
  // ...and the shopper sees something else entirely for that same state.
  assert.deepEqual(offendingPhrases(copy.savedLookSlotCopy('unknown').detail), []);
});

test('the commerce shelf names its own data gap instead of blaming the product', () => {
  const shelf = read('components/ProductShelf.tsx');
  assert.equal(shelf.includes("'Unknown Product'"), false);
  assert.match(shelf, /PRODUCT_TITLE_UNAVAILABLE/);
  assert.deepEqual(offendingPhrases(copy.PRODUCT_TITLE_UNAVAILABLE), []);
});

test('NEGATIVE CONTROL: the pre-repair rendering path fails these checks', () => {
  // The literal shape of the code this repair removed.
  const preRepairScreen = `
    const STATE_LABELS = {
      unknown: 'Ownership unknown',
    };
    <Text>{slotOwnership.confidenceExplanation}</Text>
    <Text>{'The saved slot lacks enough normalized taxonomy to decide ownership.'}</Text>
  `;

  const literals = sourceLiterals(preRepairScreen);
  const leaks = literals.flatMap(offendingPhrases);
  assert.notDeepEqual(leaks, [], 'the literal scan must flag the old copy');
  assert.ok(leaks.includes('ownership unknown'));
  assert.ok(leaks.includes('normalized taxonomy'));

  // And the diagnosis-rendering check must flag it too.
  assert.equal(/confidenceExplanation/.test(preRepairScreen), true);
});
