// Track B B1A-B5 hostile audit — Elise system-prompt chain integrity.
//
// stylechat-generate assembles its system prompt as a chain of `const`
// bindings, each one appending an optional block to the previous link, with
// the LAST link being what actually reaches the model:
//
//   baseSystemPrompt -> ...memory -> ...weather -> ...styleDna -> [more] -> model
//
// Two independent platform lineages extend this same chain. The client
// branches append the first-use gender styling context (Fix #5) and the
// stylist persona (Fix #6); the backend branch appends Track B's server-derived
// Style DNA (B5). Because the chain is expressed as plain textual bindings, a
// three-way merge of the two lineages is only safe if neither side REBINDS a
// name the other side reads.
//
// B5 originally did rebind one: it renamed the long-standing client-fed link
// `systemTextWithStyleDna` to `systemTextWithClientStyleDna` and reused the
// vacated name for its own new server-derived link. Merged with the client
// lineage, that produced a file in which the gender block read
// `systemTextWithStyleDna` ABOVE its own declaration — a const temporal-dead-
// zone ReferenceError on every StyleChat request — and in which the server
// block was computed but never consumed, because the downstream consumers had
// been repointed by the other lineage. Both failures merged CLEANLY; git had no
// way to see them.
//
// These are source-level assertions on purpose: the property being protected is
// a property of the text a merge produces, not of any single runtime path.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'supabase/functions/stylechat-generate/index.ts');
const source = fs.readFileSync(INDEX, 'utf8');

/** Character offset of `const <name> =`, or -1. */
function declarationOffset(name) {
  const m = source.match(new RegExp(`\\bconst\\s+${name}\\s*=`));
  return m && typeof m.index === 'number' ? m.index : -1;
}

function referenceOffsets(name) {
  const offsets = [];
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let m;
  while ((m = re.exec(source)) !== null) offsets.push(m.index);
  return offsets;
}

// Every binding in the assembled system-prompt chain, in the order this file
// declares them. A new link belongs in this list.
const CHAIN = [
  'systemTextWithWeather',
  'systemTextWithStyleDna',
  'systemTextWithGenderContext',
  'systemTextWithStylistName',
  'systemTextWithServerStyleDna',
  'systemTextForModelBase',
];

test('CHAIN: every prompt-chain binding is declared exactly once', () => {
  for (const name of CHAIN) {
    const declarations = source.match(new RegExp(`\\bconst\\s+${name}\\s*=`, 'g')) ?? [];
    assert.equal(
      declarations.length,
      1,
      `${name} must have exactly one declaration — two means a merge stacked both lineages' bindings`,
    );
  }
});

test('CHAIN: no prompt-chain binding is read before it is declared (const TDZ guard)', () => {
  for (const name of CHAIN) {
    const declared = declarationOffset(name);
    assert.notEqual(declared, -1, `${name} must be declared`);
    for (const offset of referenceOffsets(name)) {
      // The declaration site itself, and anything after it, is fine. A read
      // BEFORE it throws "Cannot access ... before initialization" at runtime.
      assert.ok(
        offset >= declared,
        `${name} is referenced at offset ${offset}, before its declaration at ${declared} — ` +
          'this is the exact shape a bad cross-lineage merge produces',
      );
    }
  }
});

test('CHAIN: the client-fed Style DNA link keeps its long-standing name and meaning', () => {
  // Renaming this binding is what made the other lineage's blocks read a name
  // that had silently changed meaning underneath them.
  assert.match(
    source,
    /const systemTextWithStyleDna = styleDnaContext\s*\n\s*\?\s*`\$\{systemTextWithWeather\}[\s\S]{0,80}buildStyleDnaContextBlock\(styleDnaContext\)\}`/,
    'systemTextWithStyleDna must remain the CLIENT-FED Signature Style link',
  );
  assert.doesNotMatch(
    source,
    /systemTextWithClientStyleDna/,
    'the client-fed link must not be renamed out from under the other lineage',
  );
});

test('CHAIN: each optional context is additive and the server-derived block follows first-use context', () => {
  assert.match(
    source,
    /const systemTextWithGenderContext = genderStylingContext\s*\n\s*\?\s*`\$\{systemTextWithStyleDna\}[\s\S]{0,120}buildGenderStylingContextBlock\(genderStylingContext\)\}`\s*\n\s*:\s*systemTextWithStyleDna;/,
    'gender context must extend the client-fed Signature Style link',
  );
  assert.match(
    source,
    /const systemTextWithStylistName\s*=\s*`\$\{systemTextWithGenderContext\}[\s\S]{0,60}buildStylistPersonaBlock\(stylistDisplayName\)\}`;/,
    'stylist identity must extend first-use gender context',
  );
  assert.match(
    source,
    /const systemTextWithServerStyleDna = serverStyleDnaBlock\s*\n\s*\?\s*`\$\{systemTextWithStylistName\}[\s\S]{0,60}serverStyleDnaBlock\}`\s*\n\s*:\s*systemTextWithStylistName;/,
    'the server-derived block must be additive to every earlier context, never a replacement',
  );
});

test('CHAIN: what reaches the model carries the server-derived block, not an earlier link', () => {
  const start = source.indexOf('const systemTextForModelBase');
  assert.notEqual(start, -1, 'systemTextForModelBase must exist');
  const block = source.slice(start, source.indexOf(';', start) + 1);
  assert.match(block, /systemTextWithServerStyleDna/);
  assert.doesNotMatch(
    block,
    /\bsystemTextWithStyleDna\b/,
    'consuming the pre-server link would compute the Track B block and then discard it',
  );
});

test('CHAIN: no unresolved merge markers survive in the assembled prompt source', () => {
  assert.doesNotMatch(source, /^<{7} /m);
  assert.doesNotMatch(source, /^={7}$/m);
  assert.doesNotMatch(source, /^>{7} /m);
});
