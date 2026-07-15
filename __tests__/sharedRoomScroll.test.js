const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const publicRoomScreen = fs.readFileSync(path.join(ROOT, 'app/(public)/rooms/[token].tsx'), 'utf8');

// LuxuryScreen renders PrivacyFooter as a normal-flow sibling of the content
// area (not absolutely positioned, not sticky — verified directly in
// components/luxury/LuxuryScreen.tsx and components/luxury/PrivacyFooter.tsx).
// So once the ScrollView itself is flex-bounded, it already ends above the
// footer with no overlap; measuring the footer's height and adding it again
// to the scroll content's bottom padding is redundant and creates a dead
// blank region below the last card. These tests guard against both the
// original bug (missing flex sizing → content can render past its own
// viewport) and the over-correction (double-counted footer-height padding).

test('shared-room ScrollView is flex-bounded so it cannot render past its own viewport', () => {
  const scrollViewBlocks = publicRoomScreen.match(/<ScrollView[\s\S]*?>/g) ?? [];
  assert.ok(scrollViewBlocks.length >= 2, 'expected at least the empty-state and available-state ScrollViews');
  for (const block of scrollViewBlocks) {
    assert.match(block, /style=\{styles\.flex\}/);
  }
});

test('shared-room screen does not measure or depend on footer height', () => {
  assert.doesNotMatch(publicRoomScreen, /footerHeight/);
  assert.doesNotMatch(publicRoomScreen, /onLayout=\{\(event\) => setFooterHeight/);
});

test('shared-room scroll content uses a static bottom padding, not footer-height-derived padding', () => {
  assert.match(publicRoomScreen, /scrollContent:\s*\{[\s\S]*?paddingBottom:\s*SPACING\.xxxl/);
  assert.doesNotMatch(publicRoomScreen, /paddingBottom:\s*SPACING\.xxxl\s*\+\s*footerHeight/);
});

test('footer wrapper still respects the bottom safe-area inset', () => {
  assert.match(publicRoomScreen, /<View style=\{\{ paddingBottom: insets\.bottom \}\}>/);
});
