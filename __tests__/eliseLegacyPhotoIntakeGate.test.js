// Legacy StyleChat photo intake — fail-closed activation gate (Phase 2B.3
// hostile audit).
//
// The dormant legacy intake was gated `attachmentsEnabled &&
// !visualAttachmentsEnabled`, which fails OPEN: a profile that enables
// attachments but merely OMITS EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED
// would silently revive the legacy raw-image intake and its intentless legacy
// identification. These tests pin the repair: activation now additionally
// requires an EXPLICIT exact-string opt-in, so the absence of a variable can
// never activate the route.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadFeatureFlags(env) {
  const filename = path.join(ROOT, 'constants/featureFlags.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    console,
    __DEV__: false,
    process: { env },
    require: () => {
      throw new Error('featureFlags must stay dependency-free');
    },
  });
  return mod.exports;
}

function sessionScreenSource() {
  return fs.readFileSync(path.join(ROOT, 'app/style-chat/[sessionId].tsx'), 'utf8');
}

test('legacy intake flag: missing, empty and malformed values all resolve FALSE', () => {
  for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', ' true']) {
    const env = value === undefined
      ? {}
      : { EXPO_PUBLIC_ELISE_LEGACY_PHOTO_INTAKE_ENABLED: value };
    const flags = loadFeatureFlags(env);
    assert.equal(
      flags.ELISE_LEGACY_PHOTO_INTAKE_ENABLED,
      false,
      `value ${JSON.stringify(value)} must not activate the legacy intake`,
    );
  }
});

test('legacy intake flag: only the exact string "true" opts in', () => {
  const flags = loadFeatureFlags({ EXPO_PUBLIC_ELISE_LEGACY_PHOTO_INTAKE_ENABLED: 'true' });
  assert.equal(flags.ELISE_LEGACY_PHOTO_INTAKE_ENABLED, true);
});

test('the attachment-composition hole is closed: enabling attachments without the visual flag cannot activate the legacy intake', () => {
  // The exact production-shaped hazard: aiStylist + stylechat attachments on,
  // the visual-attachments variable ABSENT (not false — absent).
  const flags = loadFeatureFlags({
    EXPO_PUBLIC_AI_STYLIST_ENABLED: 'true',
    EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED: 'true',
  });
  const attachmentsEnabled =
    flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED ||
    (flags.AI_STYLIST_UI_ENABLED && flags.STYLECHAT_ATTACHMENTS_ENABLED);
  const legacyIntakeActive =
    attachmentsEnabled &&
    !flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED &&
    flags.ELISE_LEGACY_PHOTO_INTAKE_ENABLED;
  assert.equal(attachmentsEnabled, true, 'the hazard configuration really enables attachments');
  assert.equal(legacyIntakeActive, false, 'the legacy intake stays closed without the explicit opt-in');
});

test('the session screen gates every legacy-intake surface on the explicit flag', () => {
  const source = sessionScreenSource();
  assert.match(
    source,
    /const legacyPhotoIntakeEnabled =\s*\n?\s*attachmentsEnabled && !visualAttachmentsEnabled && ELISE_LEGACY_PHOTO_INTAKE_ENABLED/,
    'the composed gate must require the explicit opt-in',
  );
  assert.ok(
    source.includes('{legacyPhotoIntakeEnabled ? (\n        <StyleChatPhotoIntake'),
    'the modal renders only under the explicit gate',
  );
  assert.ok(
    source.includes('onUploadPhoto={legacyPhotoIntakeEnabled ? () => setPhotoIntakeVisible(true) : undefined}'),
    'the photo-upload entry point honours the same gate',
  );
  assert.ok(
    !source.includes('{attachmentsEnabled && !visualAttachmentsEnabled ? (') ,
    'the fail-open composition must not survive anywhere as a render gate',
  );
});
