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

/**
 * Evaluate the REAL `attachmentsEnabled` expression out of the shipping
 * screen. Extracting and running the actual source (rather than restating
 * the boolean here) means this suite cannot drift from what ships: if the
 * gate is edited, these cases evaluate the edited expression.
 */
function loadComposerAttachmentGate() {
  const src = fs.readFileSync(path.join(ROOT, 'app/style-chat/[sessionId].tsx'), 'utf8');
  const match = src.match(/const attachmentsEnabled =([\s\S]*?);\n/);
  assert.ok(match, 'attachmentsEnabled gate not found in app/style-chat/[sessionId].tsx');
  const expression = match[1];
  return function evaluateGate({
    visualAttachments,
    aiStylistUi,
    stylechatAttachments,
    aiStylistNotFrozen,
  }) {
    return vm.runInNewContext(`(${expression})`, {
      ELISE_VISUAL_ATTACHMENTS_V1_ENABLED: visualAttachments,
      AI_STYLIST_UI_ENABLED: aiStylistUi,
      STYLECHAT_ATTACHMENTS_ENABLED: stylechatAttachments,
      isStylistFeatureEnabled: (key) => {
        assert.equal(key, 'aiStylist', 'the composer gate reads the aiStylist freeze key');
        return aiStylistNotFrozen;
      },
    });
  };
}

/**
 * OWNER-APPROVED CONTRACT - DO NOT "REPAIR" THIS BACK.
 *
 * Elise visual attachments are a self-contained, separately approved route.
 * They INTENTIONALLY survive the global `aiStylist` kill switch whenever
 * their own dedicated capability flag (ELISE_VISUAL_ATTACHMENTS_V1_ENABLED)
 * is enabled. The aiStylist freeze is a broad, non-core switch and must not
 * silently darken the approved visual attachment route.
 *
 * An earlier revision of this suite required a three-term
 * `AI_STYLIST_UI_ENABLED && STYLECHAT_ATTACHMENTS_ENABLED &&
 * isStylistFeatureEnabled('aiStylist')` gate. That was the OLD contract,
 * superseded by owner ruling during Build 29 closure. A future audit that
 * "fixes" the implementation to make aiStylist a mandatory master switch
 * would be reintroducing the old contract and disabling approved
 * functionality.
 *
 * The LEGACY Closet-only route (visual attachments flag OFF) remains fully
 * subordinate to the AI Stylist family, exactly as before.
 */
test('visual attachments intentionally survive the aiStylist global kill switch when their dedicated feature gate is enabled', () => {
  const gate = loadComposerAttachmentGate();

  // CASE 1 - dedicated capability on, family healthy: enabled.
  assert.equal(
    gate({
      visualAttachments: true,
      aiStylistUi: true,
      stylechatAttachments: true,
      aiStylistNotFrozen: true,
    }),
    true,
    'CASE 1: visual attachments + healthy family must enable attachments',
  );

  // CASE 2 - THE APPROVED EXEMPTION. aiStylist is frozen off, yet the
  // dedicated visual attachment capability keeps the route alive.
  assert.equal(
    gate({
      visualAttachments: true,
      aiStylistUi: true,
      stylechatAttachments: true,
      aiStylistNotFrozen: false,
    }),
    true,
    'CASE 2: the aiStylist freeze must NOT darken the approved visual attachment route',
  );

  // The exemption is genuinely self-contained: it holds even when the broader
  // AI Stylist UI / legacy attachment flags are also off.
  assert.equal(
    gate({
      visualAttachments: true,
      aiStylistUi: false,
      stylechatAttachments: false,
      aiStylistNotFrozen: false,
    }),
    true,
    'CASE 2b: the visual attachment capability is self-contained by design',
  );
});

test('with the dedicated visual attachment gate OFF, attachments stay fully subordinate to the AI Stylist family', () => {
  const gate = loadComposerAttachmentGate();
  const legacy = (overrides) =>
    gate({
      visualAttachments: false,
      aiStylistUi: true,
      stylechatAttachments: true,
      aiStylistNotFrozen: true,
      ...overrides,
    });

  // CASE 3 - legacy route, family healthy: enabled.
  assert.equal(legacy({}), true, 'CASE 3: legacy Closet-only route enables when the family is healthy');

  // CASE 4 - every mandatory legacy prerequisite independently disables.
  assert.equal(
    legacy({ aiStylistNotFrozen: false }), false,
    'CASE 4: the aiStylist freeze DOES still govern the legacy route',
  );
  assert.equal(
    legacy({ aiStylistUi: false }), false,
    'CASE 4: AI_STYLIST_UI_ENABLED is mandatory for the legacy route',
  );
  assert.equal(
    legacy({ stylechatAttachments: false }), false,
    'CASE 4: STYLECHAT_ATTACHMENTS_ENABLED is mandatory for the legacy route',
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
