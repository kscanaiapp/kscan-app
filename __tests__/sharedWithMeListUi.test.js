const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'app/dressing-rooms/index.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(ROOT, 'hooks/useSharedRoomMemberships.ts'), 'utf8');
const logic = fs.readFileSync(path.join(ROOT, 'services/sharedWithMeListLogic.ts'), 'utf8');
const memberships = fs.readFileSync(path.join(ROOT, 'services/sharedRoomMemberships.ts'), 'utf8');
const ownedHook = fs.readFileSync(path.join(ROOT, 'hooks/useStyleObjects.ts'), 'utf8');

test('listSharedRoomsForCurrentUser contract exposes required card fields', () => {
  assert.match(memberships, /export type SharedRoomMembershipSummary = \{/);
  for (const field of [
    'shareToken',
    'title',
    'itemCount',
    'firstOpenedAt',
    'lastAccessedAt',
    'availability',
    'updatedAt',
  ]) {
    assert.match(memberships, new RegExp(`${field}[?:]`));
  }
  assert.match(memberships, /normalizeListRow/);
  assert.match(memberships, /share_token/);
  assert.match(memberships, /item_count/);
  assert.match(memberships, /room_updated_at/);
});

test('owned and shared rooms remain clearly separated in one ScrollView', () => {
  assert.match(screen, /title="My Dressing Rooms"/);
  assert.match(screen, /title="Shared with Me"/);
  assert.match(screen, /scrollable=\{false\}/);
  assert.match(screen, /<ScrollView/);
  assert.doesNotMatch(screen, /FlatList|SectionList/);
  assert.doesNotMatch(screen, /nestedScrollEnabled/);
});

test('Create Dressing Room CTA stays on My Dressing Rooms header', () => {
  const mySection = screen.match(
    /title="My Dressing Rooms"[\s\S]*?actionLabel="New"[\s\S]*?actionAccessibilityLabel="Create new dressing room"/,
  );
  assert.ok(mySection, 'New CTA remains on My Dressing Rooms SectionHeader');
  const sharedSection = screen.match(
    /function SharedWithMeSection\([\s\S]*?function CreateRoomModal/,
  )?.[0] ?? '';
  assert.ok(sharedSection.length > 0, 'SharedWithMeSection found');
  assert.doesNotMatch(sharedSection, /actionLabel="New"/);
});

test('owned room navigation remains private-id detail route', () => {
  assert.match(screen, /router\.push\(`\/dressing-rooms\/\$\{room\.id\}`\)/);
});

test('shared card uses canonical token route helper', () => {
  assert.match(screen, /buildSharedRoomNativePath\(room\.shareToken\)/);
  assert.match(logic, /\/rooms\/\$\{encodeURIComponent\(shareToken\)\}/);
});

test('shared cards have no owner-edit controls', () => {
  const sharedCard = screen.match(
    /function SharedRoomCard\([\s\S]*?function SharedWithMeSection/,
  )?.[0] ?? '';
  assert.ok(sharedCard.length > 100, 'SharedRoomCard found');
  assert.doesNotMatch(sharedCard, /Rename|Delete Dressing Room|Add item|createDressingRoom/i);
  assert.match(sharedCard, /Remove from list/);
  assert.match(sharedCard, /StatusPill/);
  assert.match(sharedCard, /SHARED_ROOM_GLYPH|✦/);
});

test('removal confirmation uses truncated dialog title helper', () => {
  assert.match(screen, /formatSharedRoomDialogTitle/);
  assert.match(screen, /Remove shared room\?/);
  assert.match(screen, /does not delete the owner/);
  assert.match(screen, /text: 'Remove from list'/);
  assert.match(screen, /style: 'destructive'/);
});

test('focus refresh matches owned-room lifecycle', () => {
  assert.match(ownedHook, /useFocusEffect/);
  assert.match(hook, /useFocusEffect/);
  assert.match(hook, /Match owned-room focus refresh/);
});

test('actor changes use useAuthSession and invalidate in-flight requests', () => {
  assert.match(hook, /useAuthSession/);
  assert.match(hook, /clearSharedWithMeForActorChange/);
  assert.match(hook, /inFlightRef\.current = null/);
  assert.match(hook, /inFlightActorRef/);
  assert.doesNotMatch(hook, /onAuthStateChange/);
});

test('temporary failure and empty states are distinct', () => {
  assert.match(screen, /getSharedWithMeSectionPresentation/);
  assert.match(screen, /label: 'Retry'/);
  assert.match(screen, /Shared rooms will appear here after you open a Dressing Room link/);
  assert.match(logic, /Missing\/undeployed list RPC maps to temporary_failure/);
  assert.match(logic, /showEmpty = !showLoading && empty && !temporaryFailure/);
});

test('missing RPC UI path never shows empty-state copy in the failure branch', () => {
  assert.match(screen, /presentation\.showTemporaryFailure/);
  assert.match(screen, /presentation\.showEmpty/);
  assert.match(screen, /presentation\.showRetry|label: 'Retry'/);
  assert.doesNotMatch(screen, /list_shared_rooms_for_me/);
  assert.doesNotMatch(screen, /PGRST202|schema cache/);
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

test('platform-neutral contract: no platform value passed to membership APIs', () => {
  assert.doesNotMatch(hook, /Platform\.OS/);
  assert.doesNotMatch(hook, /p_platform|platform:/);
});

test('shared indicator reuses existing visual language without a new icon library', () => {
  assert.match(screen, /OWNED_ROOM_GLYPH = '◇'/);
  assert.match(screen, /SHARED_ROOM_GLYPH = '✦'/);
  assert.match(screen, /StatusPill/);
  assert.doesNotMatch(screen, /@expo\/vector-icons|react-native-vector-icons|lucide/);
});
