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

test('StyleChat restores the controlled composer add entry point', () => {
  assert.match(screen, /showAttachButton=\{visualAttachmentsEnabled && attachmentsEnabled\}/);
  assert.match(screen, /onAttachPress=\{[\s\S]*setAttachMenuOpen\(true\)/);
  assert.match(attachmentBar, /testID="stylechat-attach-button"/);
  assert.match(attachmentBar, /testID="stylechat-attach-menu"/);
});

test('StyleChat add sheet uses the resolved stylist name and keeps every approved source', () => {
  assert.match(screen, /stylistDisplayName=\{stylistDisplayName\}/);
  assert.match(attachmentBar, /Add for \$\{resolvedStylistName\}/);
  assert.match(attachmentBar, /testID="stylechat-attach-closet"/);
  assert.match(attachmentBar, /testID="stylechat-attach-choose-photos"/);
  assert.match(attachmentBar, /testID="stylechat-attach-recent"/);
  assert.match(attachmentBar, /onAddLook/);
  assert.match(attachmentBar, /onDirectImage/);
});
