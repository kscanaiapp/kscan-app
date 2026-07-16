const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'app/dressing-rooms/index.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(ROOT, 'hooks/useSharedRoomMemberships.ts'), 'utf8');
const logic = fs.readFileSync(path.join(ROOT, 'services/sharedWithMeListLogic.ts'), 'utf8');

test('owned and shared rooms remain clearly separated sections', () => {
  assert.match(screen, /title="My Dressing Rooms"/);
  assert.match(screen, /title="Shared with Me"/);
  assert.match(screen, /ListFooterComponent=\{sharedFooter\}/);
});

test('owned room navigation remains private-id detail route', () => {
  assert.match(screen, /router\.push\(`\/dressing-rooms\/\$\{room\.id\}`\)/);
});

test('shared card uses canonical token route helper', () => {
  assert.match(screen, /buildSharedRoomNativePath\(room\.shareToken\)/);
  assert.match(logic, /\/rooms\/\$\{encodeURIComponent\(shareToken\)\}/);
  assert.doesNotMatch(screen, /router\.push\(`\/dressing-rooms\/\$\{room\.shareToken/);
});

test('shared cards have no owner-edit controls', () => {
  const sharedCard = screen.match(
    /function SharedRoomCard\([\s\S]*?function SharedWithMeSection/,
  )?.[0] ?? '';
  assert.ok(sharedCard.length > 100, 'SharedRoomCard found');
  assert.doesNotMatch(sharedCard, /Rename|Delete Dressing Room|Add item|createDressingRoom/i);
  assert.match(sharedCard, /Remove from list/);
  assert.match(sharedCard, /StatusPill/);
});

test('removal confirmation uses recipient-safe copy', () => {
  assert.match(screen, /Remove shared room\?/);
  assert.match(screen, /does not delete the owner/);
  assert.match(screen, /text: 'Remove from list'/);
  assert.match(screen, /style: 'destructive'/);
  assert.doesNotMatch(screen, /Delete Dressing Room\?[\s\S]*Shared with Me/);
});

test('temporary failure and empty states are distinct', () => {
  assert.match(screen, /SHARED_WITH_ME_REFRESH_ERROR/);
  assert.match(screen, /SHARED_WITH_ME_EMPTY_TITLE/);
  assert.match(screen, /temporaryFailure/);
  assert.match(logic, /temporary_failure[\s\S]*preserve prior/i);
});

test('shared section loads through membership service only', () => {
  assert.match(hook, /listSharedRoomsForCurrentUser/);
  assert.match(hook, /removeSharedRoomForCurrentUser/);
  assert.doesNotMatch(hook, /AsyncStorage/);
  assert.doesNotMatch(hook, /from\('shared_room_memberships'\)/);
  assert.doesNotMatch(hook, /get_public_room_preview/);
  assert.doesNotMatch(screen, /resolveSharedRoomImageUrls/);
});

test('no per-card metadata network requests are introduced', () => {
  assert.doesNotMatch(screen, /fetchRoomPreview|listSharedRoomsForCurrentUser\(/);
  assert.match(screen, /useSharedRoomMemberships/);
});

test('rapid open guard and unavailable non-navigation exist', () => {
  assert.match(screen, /NAV_GUARD_MS/);
  assert.match(screen, /canOpenSharedRoom\(room\)/);
  assert.match(screen, /disabled=\{!openable \|\| removing\}/);
});

test('actor change clears prior memberships in the hook', () => {
  assert.match(hook, /clearSharedWithMeForActorChange/);
  assert.match(hook, /removedTokensRef\.current = new Set\(\)/);
});

test('focus refresh is bounded to one in-flight list request', () => {
  assert.match(hook, /inFlightRef/);
  assert.match(hook, /useFocusEffect/);
  assert.match(hook, /if \(inFlightRef\.current\)/);
});

test('platform-neutral contract: no platform value passed to membership APIs', () => {
  assert.doesNotMatch(hook, /Platform\.OS/);
  assert.doesNotMatch(hook, /p_platform|platform:/);
});

test('current room cover fallback structure remains for owned cards', () => {
  assert.match(screen, />ROOM</);
  assert.match(screen, /'SHARED'/);
  assert.match(screen, /'GONE'/);
  assert.doesNotMatch(screen, /emoji|🚀|👗|🏠/);
});

test('shared indicator is accessible beyond color alone', () => {
  assert.match(screen, /StatusPill/);
  assert.match(screen, /label=\{unavailable \? 'Unavailable' : 'Shared'\}/);
  assert.match(screen, /sharedRoomAccessibilityLabel/);
});
