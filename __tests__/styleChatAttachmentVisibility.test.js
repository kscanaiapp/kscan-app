const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

/**
 * StyleChat visual attachment entry point — visibility contract.
 *
 * DEFECT B29-V10-ATTACHMENT-REGRESSION: the composer `+` disappeared on the
 * Android V10 QA build.
 *
 * The governing decision is `attachmentsEnabled` in app/style-chat/[sessionId].tsx:
 *
 *   (ELISE_VISUAL_ATTACHMENTS_V1_ENABLED || (AI_STYLIST_UI_ENABLED && STYLECHAT_ATTACHMENTS_ENABLED))
 *   && (ELISE_VISUAL_ATTACHMENTS_V1_ENABLED || isStylistFeatureEnabled('aiStylist'))
 *
 * Every input is a build-time `process.env.EXPO_PUBLIC_*` read, so the control
 * can vanish from a build with no source change at all. These tests therefore
 * evaluate the REAL flag module against controlled environments rather than
 * asserting on source text, and separately guard the worktree's own build
 * configuration.
 */

/**
 * Loads constants/featureFlags.ts fresh against a specific environment.
 *
 * `__DEV__` is a React Native global the module reads, so it is injected
 * explicitly. It defaults to false — the value a shipped QA build sees — so a
 * flag that only works in a dev bundle cannot pass this suite by accident.
 */
function loadFeatureFlags(env, { dev = false } = {}) {
  const file = path.join(ROOT, 'constants', 'featureFlags.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  const previous = process.env;
  process.env = { ...env };
  try {
    new Function('require', 'module', 'exports', '__DEV__', outputText)(
      () => {
        throw new Error('constants/featureFlags.ts must not import runtime modules');
      },
      module,
      module.exports,
      dev,
    );
  } finally {
    process.env = previous;
  }
  return module.exports;
}

/**
 * The composer's decision, expressed once here and pinned to the component by
 * `attachment gate in the composer matches the contract under test` below, so
 * this helper cannot silently drift away from what actually ships.
 */
function attachmentsEnabled(flags, { aiStylistFrozen = false } = {}) {
  const isStylistFeatureEnabled = () => !aiStylistFrozen;
  return (
    (flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED ||
      (flags.AI_STYLIST_UI_ENABLED && flags.STYLECHAT_ATTACHMENTS_ENABLED)) &&
    (flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED || isStylistFeatureEnabled('aiStylist'))
  );
}

/** Parses a .env file into a plain object. Values are never logged. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return null;
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const ENABLED_ENV = {
  EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED: 'true',
  EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED: 'true',
  EXPO_PUBLIC_AI_STYLIST_ENABLED: 'true',
};

// -- Gate semantics -----------------------------------------------------------

test('the dedicated attachment authority alone makes the control available', () => {
  const flags = loadFeatureFlags({ EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED: 'true' });
  assert.equal(flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED, true);
  assert.equal(attachmentsEnabled(flags), true);
});

test('the attachment route survives a broader aiStylist freeze', () => {
  // Historical defect: Android suppressed the visual attachment route through
  // the non-core aiStylist freeze. The dedicated authority must outrank it.
  const flags = loadFeatureFlags(ENABLED_ENV);
  assert.equal(attachmentsEnabled(flags, { aiStylistFrozen: true }), true);
});

test('the legacy Closet-only route remains subordinate to the aiStylist freeze', () => {
  const flags = loadFeatureFlags({
    EXPO_PUBLIC_AI_STYLIST_ENABLED: 'true',
    EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED: 'true',
  });
  assert.equal(attachmentsEnabled(flags, { aiStylistFrozen: false }), true);
  assert.equal(attachmentsEnabled(flags, { aiStylistFrozen: true }), false);
});

test('an environment carrying none of the authorities hides the control', () => {
  const flags = loadFeatureFlags({});
  assert.equal(flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED, false);
  assert.equal(attachmentsEnabled(flags), false);
});

test('the flags are exported and are strict boolean reads', () => {
  // Historical defect: the flag was referenced but not exported on one line.
  const flags = loadFeatureFlags(ENABLED_ENV);
  for (const name of [
    'ELISE_VISUAL_ATTACHMENTS_V1_ENABLED',
    'STYLECHAT_ATTACHMENTS_ENABLED',
    'AI_STYLIST_UI_ENABLED',
  ]) {
    assert.equal(typeof flags[name], 'boolean', `${name} must be exported as a boolean`);
  }
  // Only the exact string 'true' enables; a stray value must not.
  const loose = loadFeatureFlags({ EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED: '1' });
  assert.equal(loose.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED, false);
});

// -- The gate is independent of avatar / speech state -------------------------

test('attachment visibility depends on no avatar, speech or V10 input', () => {
  // The control must not disappear because V10 is enabled, shadow mode is on,
  // speech is on or off, or the active stylist changed. The decision reads
  // three feature flags and the aiStylist freeze — nothing else.
  const flags = loadFeatureFlags(ENABLED_ENV);
  for (const visualMode of ['LEGACY', 'V10_SHADOW', 'V10_VISIBLE', undefined]) {
    const withMode = loadFeatureFlags({ ...ENABLED_ENV, EXPO_PUBLIC_AVATAR_VISUAL_MODE: visualMode });
    assert.equal(
      attachmentsEnabled(withMode),
      attachmentsEnabled(flags),
      `avatar visual mode ${visualMode} must not affect attachment visibility`,
    );
  }
});

// -- Build configuration guard (the negative control) -------------------------

test('the worktree build environment enables the attachment authority', () => {
  // THIS is the test that reproduces the reported device defect. The source is
  // byte-identical to the last known-good authority; the control disappeared
  // because this worktree's .env — which is gitignored and therefore never
  // travels with a branch, a cherry-pick or a new worktree — carries none of
  // the three governing flags.
  const env = readEnvFile(path.join(ROOT, '.env'));
  assert.ok(env, '.env must exist for a device QA build');

  const flags = loadFeatureFlags(env);
  assert.equal(
    attachmentsEnabled(flags),
    true,
    'the QA build environment must enable the StyleChat attachment entry point',
  );
});

// -- Governance: the helper above must match what ships -----------------------

test('attachment gate in the composer matches the contract under test', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
  const normalized = source.replace(/\s+/g, ' ');
  assert.ok(
    normalized.includes(
      'const attachmentsEnabled = (ELISE_VISUAL_ATTACHMENTS_V1_ENABLED || ' +
        '(AI_STYLIST_UI_ENABLED && STYLECHAT_ATTACHMENTS_ENABLED)) && ' +
        '(ELISE_VISUAL_ATTACHMENTS_V1_ENABLED || isStylistFeatureEnabled(\'aiStylist\'))',
    ),
    'the composer gate changed; update the contract helper in this file to match',
  );
  // The three attachment actions must remain wired to the same gate.
  assert.ok(normalized.includes('{attachmentsEnabled ? ( <StyleChatAttachmentBar'));
});
