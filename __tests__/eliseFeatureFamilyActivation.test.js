// Elise AI Stylist feature-family activation state (Android v26).
//
// Owner ruling: AI Stylist and Elise visual attachments are ONE feature
// family and must be ENABLED in the authoritative Android candidate
// configuration. This suite locks the resolved gate chain end to end so a
// future config regression cannot silently darken the feature.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadFeatureFlags(env) {
  const source = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
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

const CANDIDATE_ENV = {
  EXPO_PUBLIC_AI_STYLIST_ENABLED: 'true',
  EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED: 'true',
};

test('eas.json enables the feature family in every Android profile', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  for (const profile of ['development', 'preview', 'production']) {
    const env = eas.build[profile].env;
    assert.equal(
      env.EXPO_PUBLIC_AI_STYLIST_ENABLED,
      'true',
      `${profile}: AI Stylist must be enabled`,
    );
    assert.equal(
      env.EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED,
      'true',
      `${profile}: attachments must be enabled`,
    );
  }
});

test('candidate env resolves both family flags true; missing env stays safe-false', () => {
  const on = loadFeatureFlags(CANDIDATE_ENV);
  assert.equal(on.AI_STYLIST_UI_ENABLED, true);
  assert.equal(on.STYLECHAT_ATTACHMENTS_ENABLED, true);

  const off = loadFeatureFlags({});
  assert.equal(off.AI_STYLIST_UI_ENABLED, false);
  assert.equal(off.STYLECHAT_ATTACHMENTS_ENABLED, false);

  const malformed = loadFeatureFlags({
    EXPO_PUBLIC_AI_STYLIST_ENABLED: 'TRUE-ish',
    EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED: '1',
  });
  assert.equal(malformed.AI_STYLIST_UI_ENABLED, false, 'malformed value must not enable');
  assert.equal(malformed.STYLECHAT_ATTACHMENTS_ENABLED, false, 'malformed value must not enable');
});

test('remote feature-freeze defaults open so aiStylist passes without a freeze', () => {
  const flags = loadFeatureFlags({});
  assert.equal(flags.DEFAULT_FEATURE_FREEZE_CONFIG.featureFreeze, false);
});

test('composer attachment gate uses exactly the family terms (no hidden gate)', () => {
  const session = fs.readFileSync(path.join(ROOT, 'app/style-chat/[sessionId].tsx'), 'utf8');
  assert.match(
    session,
    /AI_STYLIST_UI_ENABLED &&\s*\n?\s*STYLECHAT_ATTACHMENTS_ENABLED &&\s*\n?\s*isStylistFeatureEnabled\('aiStylist'\)/,
    'composer gate must be the three-term family gate',
  );
});

test('stylist entry surface gates only on the family terms', () => {
  const stylist = fs.readFileSync(path.join(ROOT, 'app/stylist/index.tsx'), 'utf8');
  assert.match(
    stylist,
    /!AI_STYLIST_UI_ENABLED \|\| !isFeatureEnabled\('aiStylist'\)/,
    'entry guard must be the family guard',
  );
});

test('attachments stay a single family: no separate upload product control', () => {
  // The subordinate kill switch may exist, but no code path may enable
  // attachments without AI Stylist.
  const files = [
    'app/style-chat/[sessionId].tsx',
    'app/stylist/index.tsx',
    'app/looks/[id].tsx',
    'app/library.tsx',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/STYLECHAT_ATTACHMENTS_ENABLED/g)) {
      // Every attachment reference must appear in a file that also imports
      // the AI Stylist gate — attachments never ship standalone.
      assert.match(src, /AI_STYLIST_UI_ENABLED/, `${rel} must couple attachments to AI Stylist`);
      break;
    }
  }
});
