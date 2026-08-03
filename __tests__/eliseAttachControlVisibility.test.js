const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('composer renders the attachment bar through only the documented capability gate', () => {
  const route = read('app/style-chat/[sessionId].tsx');

  assert.match(
    route,
    /const attachmentsEnabled =\s*AI_STYLIST_UI_ENABLED &&\s*STYLECHAT_ATTACHMENTS_ENABLED &&\s*isStylistFeatureEnabled\('aiStylist'\);/,
    'the entry point must use the established local flags plus the remote non-core freeze',
  );
  assert.match(
    route,
    /\{attachmentsEnabled \? \(\s*<StyleChatAttachmentBar[\s\S]*?onUploadPhoto=\{\(\) => setPhotoIntakeVisible\(true\)\}/,
    'an enabled attachment family must render the bar and preserve direct photo intake',
  );

  const gate = route.match(/const attachmentsEnabled =([\s\S]*?);/)?.[1] ?? '';
  assert.doesNotMatch(gate, /closet|scan|weather|pending|response/i);
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
