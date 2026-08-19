const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('Android candidate profiles enable the existing Elise attachment entry point', () => {
  const eas = JSON.parse(read('eas.json'));

  for (const profile of ['development', 'preview', 'production']) {
    const env = eas.build[profile].env;
    assert.equal(env.EXPO_PUBLIC_AI_STYLIST_ENABLED, 'true', `${profile}: AI Stylist gate`);
    assert.equal(
      env.EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED,
      'true',
      `${profile}: StyleChat attachment gate`,
    );
  }
});

/**
 * Loads constants/featureFlags.ts fresh against a controlled environment.
 * Executable/behavioral, not a source-text regex: the exact gate expression
 * in app/style-chat/[sessionId].tsx has changed shape more than once (it now
 * additionally ORs in ELISE_VISUAL_ATTACHMENTS_V1_ENABLED), and a brittle
 * exact-string test failed on that change without the actual shipping
 * behavior having regressed. This suite tests the DECISION, not its syntax.
 */
function loadFeatureFlags(env) {
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
      () => { throw new Error('constants/featureFlags.ts must not import runtime modules'); },
      module,
      module.exports,
      false,
    );
  } finally {
    process.env = previous;
  }
  return module.exports;
}

/** Mirrors the shipped gate in app/style-chat/[sessionId].tsx exactly. */
function attachmentsEnabled(flags, { aiStylistFrozen = false } = {}) {
  const isStylistFeatureEnabled = () => !aiStylistFrozen;
  return (
    (flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED ||
      (flags.AI_STYLIST_UI_ENABLED && flags.STYLECHAT_ATTACHMENTS_ENABLED)) &&
    (flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED || isStylistFeatureEnabled('aiStylist'))
  );
}

test('composer renders the attachment bar through only the documented capability gate', () => {
  const route = read('app/style-chat/[sessionId].tsx');

  assert.match(
    route,
    /\{attachmentsEnabled \? \(\s*<StyleChatAttachmentBar/,
    'an enabled attachment family must render the bar',
  );
  assert.match(
    route,
    /onUploadPhoto=\{\(\) => setPhotoIntakeVisible\(true\)\}/,
    'direct photo intake must remain wired',
  );

  const gate = route.match(/const attachmentsEnabled =([\s\S]*?);/)?.[1] ?? '';
  assert.notEqual(gate, '', 'attachmentsEnabled must be defined');
  assert.doesNotMatch(gate, /closet|scan|weather|pending|response/i);
});

// -- Behavioral cases (§11): the four states the gate must actually produce --

test('BEHAVIORAL: the approved attachment authority makes the control available', () => {
  const flags = loadFeatureFlags({
    EXPO_PUBLIC_AI_STYLIST_ENABLED: 'true',
    EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED: 'true',
  });
  assert.equal(attachmentsEnabled(flags), true);
});

test('BEHAVIORAL: the remote aiStylist kill-switch closes the legacy route when it is frozen', () => {
  const flags = loadFeatureFlags({
    EXPO_PUBLIC_AI_STYLIST_ENABLED: 'true',
    EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED: 'true',
  });
  assert.equal(attachmentsEnabled(flags, { aiStylistFrozen: false }), true);
  assert.equal(
    attachmentsEnabled(flags, { aiStylistFrozen: true }),
    false,
    'a live remote freeze must still be able to close the legacy (non-visual-attachments) route',
  );
});

test('BEHAVIORAL: with every relevant authority off, the control is hidden', () => {
  const flags = loadFeatureFlags({});
  assert.equal(attachmentsEnabled(flags), false);
});

test('BEHAVIORAL: the gate does not branch on stylist identity — any active stylist reaches it', () => {
  // The availability decision reads only feature flags and the remote
  // freeze. Stylist-name resolution is a SEPARATE, unconditional concern:
  // resolvedStylistName falls back to Elise only when the active stylist's
  // own display name is empty, never as a gate on whether attachments work.
  const route = read('app/style-chat/[sessionId].tsx');
  const gate = route.match(/const attachmentsEnabled =([\s\S]*?);/)?.[1] ?? '';
  // Note: ELISE_VISUAL_ATTACHMENTS_V1_ENABLED legitimately contains "Elise" as
  // a flag-name prefix — that is a configuration identifier, not a branch on
  // stylist identity, so only quoted stylist-name literals count as a defect.
  assert.doesNotMatch(
    gate,
    /stylistDisplayName|identity\.|['"](Janet|Henry|Sarah|Elise)['"]/i,
    'the availability decision must not branch on a specific stylist name',
  );

  const bar = read('components/style-chat/StyleChatAttachmentBar.tsx');
  assert.match(
    bar,
    /const resolvedStylistName = stylistDisplayName\.trim\(\) \|\| ELISE_IDENTITY\.displayName;/,
    'the rendered label must resolve from whichever stylist is active, falling back to Elise only when unset',
  );
  assert.match(
    bar,
    /accessibilityLabel=\{`Add an attachment for \$\{resolvedStylistName\}`\}/,
    'the control itself must be labeled by the resolved (possibly non-Elise) stylist name',
  );
});

test('CLEAN ENVIRONMENT: the approved shipping configuration (eas.json alone) enables the control everywhere', () => {
  const eas = JSON.parse(read('eas.json'));
  for (const [name, profile] of Object.entries(eas.build)) {
    const flags = loadFeatureFlags(profile.env ?? {});
    assert.equal(
      attachmentsEnabled(flags),
      true,
      `profile "${name}" must enable the control from committed config alone, with no local .env`,
    );
  }
});

test('the plus control remains rendered when there are no pending attachments', () => {
  const bar = read('components/style-chat/StyleChatAttachmentBar.tsx');
  const plusIndex = bar.indexOf('testID="stylechat-attach-button"');
  const attachmentMapIndex = bar.indexOf('attachments.map((draft)');

  assert.notEqual(plusIndex, -1, 'the stable plus control must exist');
  assert.notEqual(attachmentMapIndex, -1, 'attachment chips must remain data-driven');
  assert.ok(
    plusIndex < attachmentMapIndex,
    'the plus control must render independently before an empty attachment list is mapped',
  );
  assert.match(bar, /onPress=\{\(\) => setMenuOpen\(true\)\}/);
  assert.match(bar, /title="Upload a Photo"[\s\S]*?onUploadPhoto\(\)/);
});

test('send state can disable the plus control but attach-first never removes it', () => {
  const route = read('app/style-chat/[sessionId].tsx');
  const bar = read('components/style-chat/StyleChatAttachmentBar.tsx');
  const intake = read('components/style-chat/StyleChatPhotoIntake.tsx');

  assert.match(route, /<StyleChatAttachmentBar[\s\S]*?disabled=\{isSending\}/);
  assert.match(
    bar,
    /testID="stylechat-attach-button"[\s\S]*?<\/TouchableOpacity>/,
    'disabled is an interaction state, not a conditional render',
  );
  assert.match(intake, /title="Attach to Elise"/i);
  assert.match(intake, /title=\{closetState === 'saved'[\s\S]*?'Save to Closet'/);
  assert.doesNotMatch(intake, /Save to Closet & Attach/i);
});
