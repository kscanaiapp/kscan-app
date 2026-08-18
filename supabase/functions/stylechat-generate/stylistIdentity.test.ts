import assert from 'node:assert/strict';

import {
  CANONICAL_PORTRAIT_NAMES,
  SAFE_DEFAULT_STYLIST_NAME,
  resolveCanonicalStylistName,
  resolveStylistDisplayName,
  buildStylistPersonaBlock,
} from './stylistIdentity.ts';

const indexSource = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));

const CANONICAL_TESTS: Array<[string, string]> = [
  ['stylist_portrait_01', 'Elise'],
  ['stylist_portrait_02', 'Henry'],
  ['stylist_portrait_03', 'Janet'],
  ['stylist_portrait_04', 'Marie'],
  ['stylist_portrait_05', 'Sarah'],
  ['stylist_portrait_06', 'Vivian'],
  ['stylist_portrait_07', 'Isabella'],
  ['stylist_portrait_08', 'Michael'],
  ['stylist_portrait_09', 'David'],
  ['stylist_portrait_10', 'Kim'],
];

for (const [avatarId, expectedName] of CANONICAL_TESTS) {
  Deno.test(`CANONICAL_${avatarId.slice(-2)}_${expectedName.toUpperCase()}: ${avatarId} resolves to ${expectedName} with no custom name`, () => {
    assert.equal(resolveCanonicalStylistName(avatarId), expectedName);
    assert.equal(resolveStylistDisplayName(null, avatarId), expectedName);
    assert.equal(resolveStylistDisplayName(undefined, avatarId), expectedName);
  });
}

Deno.test('exactly ten canonical portrait names are defined, no more no less', () => {
  assert.equal(Object.keys(CANONICAL_PORTRAIT_NAMES).length, 10);
});

Deno.test('abstract presets and unknown avatar ids fall back to the safe default', () => {
  assert.equal(resolveCanonicalStylistName('elise_default'), SAFE_DEFAULT_STYLIST_NAME);
  assert.equal(resolveCanonicalStylistName('editorial_plum'), SAFE_DEFAULT_STYLIST_NAME);
  assert.equal(resolveCanonicalStylistName('unknown_avatar'), SAFE_DEFAULT_STYLIST_NAME);
  assert.equal(resolveCanonicalStylistName(null), SAFE_DEFAULT_STYLIST_NAME);
  assert.equal(resolveCanonicalStylistName(undefined), SAFE_DEFAULT_STYLIST_NAME);
  assert.equal(resolveCanonicalStylistName(123), SAFE_DEFAULT_STYLIST_NAME);
});

Deno.test('CUSTOM_ALEX_OVERRIDES_HENRY: a valid stored custom name always wins over the canonical portrait name', () => {
  assert.equal(resolveStylistDisplayName('Alex', 'stylist_portrait_02'), 'Alex');
  assert.equal(resolveStylistDisplayName('Alex', 'stylist_portrait_09'), 'Alex');
  assert.equal(resolveStylistDisplayName('Zoe', 'elise_default'), 'Zoe');
});

Deno.test('NO_GENDER_INFERENCE-equivalent: the resolver never derives a name from anything but the stored custom value and avatarId', () => {
  // The function signature itself only accepts (customName, avatarId) — there is
  // no third input it could use to infer a name from. This test pins that shape.
  assert.equal(resolveStylistDisplayName.length, 2);
});

Deno.test('malformed/out-of-bounds stored custom names fall back to canonical, not a crash', () => {
  assert.equal(resolveStylistDisplayName('', 'stylist_portrait_02'), 'Henry');
  assert.equal(resolveStylistDisplayName('A', 'stylist_portrait_02'), 'Henry'); // below min length 2
  assert.equal(resolveStylistDisplayName('A'.repeat(25), 'stylist_portrait_02'), 'Henry'); // above max length 24
  assert.equal(resolveStylistDisplayName(123, 'stylist_portrait_02'), 'Henry');
  assert.equal(resolveStylistDisplayName({ name: 'Alex' }, 'stylist_portrait_02'), 'Henry');
  assert.equal(resolveStylistDisplayName(['Alex'], 'stylist_portrait_02'), 'Henry');
});

Deno.test('control characters are stripped and the result is re-bounds-checked', () => {
  assert.equal(resolveStylistDisplayName('A\x00l\x1Fex', 'stylist_portrait_02'), 'Alex');
  // Only control chars + whitespace inside a too-short name after stripping -> canonical fallback.
  assert.equal(resolveStylistDisplayName('\x00\x01', 'stylist_portrait_02'), 'Henry');
});

Deno.test('DEFAULT_HENRY_MODEL_PERSONA / CUSTOM_ALEX_MODEL_PERSONA: the persona block always names exactly the resolved name, nothing else', () => {
  const henryBlock = buildStylistPersonaBlock(resolveStylistDisplayName(null, 'stylist_portrait_02'));
  assert.match(henryBlock, /Your name is Henry\./);
  assert.doesNotMatch(henryBlock, /Alex/);

  const alexBlock = buildStylistPersonaBlock(resolveStylistDisplayName('Alex', 'stylist_portrait_02'));
  assert.match(alexBlock, /Your name is Alex\./);
  // MODEL_DOES_NOT_REASSERT_HENRY_WHEN_CUSTOM_NAME_IS_ALEX
  assert.doesNotMatch(alexBlock, /Henry/);
});

Deno.test('persona block is compact, bracketed, and self-contained (matches the Style DNA / gender-context block convention)', () => {
  const block = buildStylistPersonaBlock('Henry');
  assert.ok(block.startsWith('[Stylist Persona]'));
  assert.ok(block.endsWith('[/Stylist Persona]'));
});

Deno.test('STYLIST_02_REMAINS_STYLIST_02_AFTER_RENAME: resolving a display name never returns or mutates an avatarId', () => {
  const name = resolveStylistDisplayName('Alex', 'stylist_portrait_02');
  assert.equal(typeof name, 'string');
  assert.notEqual(name, 'stylist_portrait_02');
});

// ── index.ts wiring: the crux of the whole design ────────────────────────────
// A pre-Fix-#6 row's historical 'Elise' must never be mistaken for a
// deliberate customization once a different avatar's canonical name should
// apply. This is enforced entirely by gating on display_name_customized
// before ever passing display_name into the resolver.

Deno.test('index.ts queries display_name_customized alongside display_name/avatar_id', () => {
  assert.match(
    indexSource,
    /select\(\s*['"]display_name, display_name_customized, avatar_id['"]\s*\)/,
  );
});

Deno.test('index.ts only passes display_name to the resolver when display_name_customized === true', () => {
  const call = indexSource.match(
    /stylistDisplayName = resolveStylistDisplayName\(\s*([\s\S]*?),\s*stylistPrefsRow\?\.avatar_id,?\s*\);/,
  )?.[1];
  assert.ok(call, 'expected the resolveStylistDisplayName call site');
  assert.match(call, /display_name_customized === true/);
  assert.match(call, /:\s*null/);
});

Deno.test('index.ts imports the resolver from stylistIdentity.ts, not a re-implementation', () => {
  assert.match(
    indexSource,
    /import\s*\{[\s\S]*?resolveStylistDisplayName[\s\S]*?buildStylistPersonaBlock[\s\S]*?\}\s*from\s*['"]\.\/stylistIdentity\.ts['"]/,
  );
});

Deno.test('the persona block feeds the same downstream prompt chain every other context block uses (no separate/parallel prompt path)', () => {
  assert.match(indexSource, /systemTextWithStylistName =[\s\S]*?systemTextWithGenderContext[\s\S]*?buildStylistPersonaBlock/);
  // Every downstream consumer must read the post-persona variable, not the
  // pre-persona one -- otherwise the model persona name would be silently
  // dropped from the final prompt actually sent to Gemini.
  const afterDefinition = indexSource.slice(indexSource.indexOf('const systemTextWithStylistName'));
  assert.doesNotMatch(afterDefinition.slice(afterDefinition.indexOf(';') + 1), /systemTextWithGenderContext/);
});
