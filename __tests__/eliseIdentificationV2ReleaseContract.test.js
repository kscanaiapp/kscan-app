// Elise Identification V2 — production release contract.
//
// WHY THIS SUITE EXISTS (P1, found by device QA on the Build 25 candidate):
// `EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED` was absent from every eas.json
// profile, so the client resolved it to false and took the legacy
// identification path. The legacy path populates title/category/colour but
// never sets `fashionContext`, and "Attach to Elise" is gated on
// `fashionContext` while "Save to Closet" is not. The shipping configuration
// therefore rendered a review sheet that looked successful while the core
// attach-first action could never activate.
//
// The existing attach-first suites assert source STRUCTURE. None of them read
// the build configuration, so none of them could fail on a dark flag. This
// suite closes that gap: it pins the production candidate's resolved gate.
//
// Scope note: staging is deliberately NOT asserted. The staging environment is
// not ready for V2 and this repair ships to the production candidate only, so
// requiring the flag there would encode a rollout the owner has not approved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const FLAG = 'EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED';

function loadFeatureFlags(env) {
  const source = read('constants/featureFlags.ts');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    process: { env },
    require: (id) => {
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename: 'featureFlags.ts' });
  return mod.exports;
}

const easBuild = () => JSON.parse(read('eas.json')).build;

test('the production profile explicitly enables Elise Identification V2', () => {
  const env = easBuild().production.env;
  assert.equal(
    env[FLAG],
    'true',
    'production must explicitly enable Elise Identification V2 — without it the ' +
      'candidate ships the legacy path and "Attach to Elise" can never activate',
  );
});

test('the production literal resolves to enabled through the real resolver', () => {
  // Guards a typo'd value ("TRUE", "1", boolean true) that reads as configured
  // in review but resolves to false at runtime.
  const { resolveEliseIdentificationV2Enabled } = loadFeatureFlags({});
  const literal = easBuild().production.env[FLAG];
  assert.equal(
    resolveEliseIdentificationV2Enabled(literal),
    true,
    `production value ${JSON.stringify(literal)} must resolve to enabled`,
  );
});

test('NEGATIVE CONTROL: the pre-repair configuration resolves to disabled', () => {
  // This is the exact defect the contract above guards. If this ever reports
  // enabled, the resolver has stopped failing closed and the release contract
  // is no longer meaningful.
  const { resolveEliseIdentificationV2Enabled } = loadFeatureFlags({});
  assert.equal(
    resolveEliseIdentificationV2Enabled(undefined),
    false,
    'an absent flag must resolve to disabled (fail closed)',
  );
  assert.equal(resolveEliseIdentificationV2Enabled('TRUE'), false);
  assert.equal(resolveEliseIdentificationV2Enabled('1'), false);
});

test('the flag is load-bearing: only the V2 identified outcome supplies fashionContext', () => {
  const intake = read('components/style-chat/StyleChatPhotoIntake.tsx');

  // The V2 branch is gated on the latched session flag...
  assert.match(
    intake,
    /if\s*\(\s*v2Flag\.enabled\s*&&\s*prepared\.base64\s*\)/,
    'V2 identification must be gated on the latched session flag',
  );
  // ...and that branch is the only place a real context is produced.
  const contextAssignments = intake.match(/setFashionContext\(([^)]*)\)/g) ?? [];
  const nonNull = contextAssignments.filter((call) => !/\(\s*null\s*\)/.test(call));
  assert.equal(
    nonNull.length,
    1,
    `exactly one non-null setFashionContext assignment expected, found ${nonNull.length}: ` +
      `${nonNull.join(', ')} — a second producer would change which paths can attach`,
  );
  assert.match(nonNull[0], /outcome\.context/);
});

test('attach is gated on identified context while Closet save is not', () => {
  const intake = read('components/style-chat/StyleChatPhotoIntake.tsx');

  // The asymmetry is intentional (Closet may hold a manually described item),
  // but it is precisely why a dark V2 flag disables attach and nothing else —
  // the failure is silent. Pin it so the coupling stays visible.
  assert.match(
    intake,
    /disabled=\{!title\.trim\(\)\s*\|\|\s*!category\.trim\(\)\s*\|\|\s*!fashionContext\}/,
    'Attach to Elise must remain gated on a real identified context',
  );
  assert.match(
    intake,
    /disabled=\{!title\.trim\(\)\s*\|\|\s*!category\.trim\(\)\s*\|\|\s*closetState === 'saved'\}/,
    'Save to Closet must stay independent of the Elise attachment context',
  );
  // Attaching must never be reachable with a null context.
  assert.match(intake, /if\s*\(!fashionContext\)\s*\{/);
});
