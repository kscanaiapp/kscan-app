const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
const attachmentBar = fs.readFileSync(
  path.join(ROOT, 'components', 'style-chat', 'StyleChatAttachmentBar.tsx'),
  'utf8',
);

test('StyleChat restores the approved add control when attachments are enabled', () => {
  assert.match(screen, /ELISE_VISUAL_ATTACHMENTS_V1_ENABLED/);
  assert.match(screen, /ELISE_VISUAL_ATTACHMENTS_V1_ENABLED \|\| isStylistFeatureEnabled\('aiStylist'\)/);
  assert.match(screen, /attachmentsEnabled \? \(/);
  assert.match(attachmentBar, /testID="stylechat-attach-button"/);
  assert.match(attachmentBar, /onPress=\{\(\) => setMenuOpen\(true\)\}/);
});

test('StyleChat add sheet resolves the active stylist and keeps its existing options', () => {
  assert.match(screen, /stylistDisplayName=\{stylistDisplayName\}/);
  assert.match(attachmentBar, /Add for \$\{resolvedStylistName\}/);
  assert.match(attachmentBar, /title="Add From Closet"/);
  assert.match(attachmentBar, /title="Add a Look"/);
  assert.match(attachmentBar, /title="Upload a Photo"/);
  assert.match(attachmentBar, /onUploadPhoto\(\)/);
  assert.match(attachmentBar, /Add From Closet for \$\{stylistDisplayName\}/);
  assert.match(attachmentBar, /Add a Look for \$\{stylistDisplayName\}/);
});
