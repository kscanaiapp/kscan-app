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
  assert.match(logic, /normalizeRoomShareToken\(shareToken\)/);
  assert.match(logic, /\/rooms\/\$\{encodeURIComponent\(normalizedToken\)\}/);
  assert.match(screen, /const path = buildSharedRoomNativePath\(room\.shareToken\);\s+if \(!path\) return;/);
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
  assert.match(screen, /removePromptTokenRef/);
  assert.match(screen, /onDismiss: clearPromptGuard/);
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

test('actor-keyed render boundary hides prior rooms before passive effects', () => {
  assert.match(hook, /const actorId = !authLoading && isAuthenticated && user\?\.id/);
  assert.match(hook, /actorIdRef\.current = actorId/);
  assert.match(hook, /isSharedWithMeSnapshotVisibleToActor/);
  assert.match(hook, /snapshotVisible[\s\S]*rooms: \[\]/);
  assert.doesNotMatch(hook, /useEffect\(\(\) => \{\s+actorIdRef\.current = actorId/);
});

test('list and removal completions are actor and generation scoped', () => {
  assert.match(hook, /const requestActorId = actorId/);
  assert.match(hook, /const requestActorId = actorIdRef\.current/);
  assert.match(hook, /actorIdRef\.current !== requestActorId/);
  assert.match(hook, /generationRef\.current \+ 1/);
  assert.match(hook, /previous\.actorId === requestActorId/);
  assert.match(hook, /restoreSharedRoomAfterFailedRemovalForActor/);
  assert.doesNotMatch(hook, /let generation = 0/);
});

test('removal suppression is actor-keyed, bounded, and released after stale work', () => {
  assert.match(hook, /createSharedRoomRemovalSuppression\(actorId\)/);
  assert.match(hook, /rememberRemovedSharedRoomToken/);
  assert.match(hook, /removedSharedRoomTokensForActor/);
  assert.match(hook, /const removedTokensAtCompletion = new Set/);
  assert.match(hook, /removedTokens: removedTokensAtCompletion/);
  assert.match(hook, /clearSharedRoomRemovalSuppression/);
  assert.match(logic, /SHARED_ROOM_REMOVAL_SUPPRESSION_MAX = 100/);
  assert.doesNotMatch(hook, /removedTokensRef/);
});

test('one request is deduplicated per actor and unmount blocks state completion', () => {
  assert.match(hook, /if \(inFlightRef\.current\)/);
  assert.match(hook, /inFlightActorRef\.current === actorId/);
  assert.match(hook, /if \(!mountedRef\.current\) return/);
  assert.match(hook, /mountedRef\.current = false/);
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

test('shared cards derive access copy from the capability resolver', () => {
  // V17 hotfix: the card no longer hard-codes every shared room as
  // "Shared · View only" — the pill and the spoken description both come
  // from resolveSharedRoomCapabilities so collaborators are labeled
  // accurately and viewers stay view-only.
  assert.match(screen, /sharedRoomStatusLabel\(\{/);
  assert.doesNotMatch(screen, /'Shared · View only'/);
  assert.match(logic, /sharedRoomAccessA11y\(\{/);
  const capabilities = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'sharedRoomCapabilities.ts'),
    'utf8',
  );
  assert.match(capabilities, /'Shared · View only'/);
  assert.match(capabilities, /'Shared · Collaborator'/);
  assert.match(capabilities, /'Shared · Unavailable'/);
  assert.match(screen, /sharedRoomItemCountLabel\(room\)/);
  assert.match(screen, /accessibilityLabel=\{`Remove \$\{title\} from Shared with Me list`\}/);
});

test('owned room creation, empty state, grid sizing, safe area, and footer remain intact', () => {
  assert.match(screen, /createDressingRoom\(\{ userId: user\?\.id, title, description \}\)/);
  assert.match(screen, /title="Start Your First Styling Room"/);
  assert.match(screen, /router\.push\(`\/dressing-rooms\/\$\{room\.id\}`\)/);
  assert.match(screen, /gridItem:\s*\{\s*width: '50%'/);
  assert.match(screen, /<LuxuryScreen[\s\S]*?scrollable=\{false\}[\s\S]*?safeArea/);
  assert.match(screen, /<PrivacyFooter/);
});

test('failed removal restores the card with safe retry guidance', () => {
  assert.match(logic, /SHARED_WITH_ME_REMOVE_ERROR/);
  assert.match(logic, /try Remove from list again/);
  assert.match(hook, /restoreSharedRoomAfterFailedRemovalForActor/);
});

test('remove button shows a busy spinner instead of silently disabling, matching Create Room', () => {
  const sharedCard = screen.match(
    /function SharedRoomCard\([\s\S]*?function SharedRoomSkeletonCard/,
  )?.[0] ?? '';
  assert.ok(sharedCard.length > 100, 'SharedRoomCard found');
  assert.match(sharedCard, /loading=\{removing\}/);
  assert.match(sharedCard, /disabled=\{removing\}/);
  assert.match(sharedCard, /accessibilityState=\{\{ disabled: !openable \|\| removing, busy: removing \}\}/);
  // Same loading-prop convention already used by the owned-room create flow.
  assert.match(screen, /loading=\{saving\}/);
});

test('shared card entrance respects reduced motion and stays under useNativeDriver', () => {
  const sharedCard = screen.match(
    /function SharedRoomCard\([\s\S]*?function SharedRoomSkeletonCard/,
  )?.[0] ?? '';
  assert.match(screen, /useReducedMotion/);
  assert.match(sharedCard, /const reducedMotion = useReducedMotion\(\);/);
  assert.match(sharedCard, /if \(reducedMotion\) \{\s+enter\.setValue\(1\);/);
  assert.match(sharedCard, /useNativeDriver: true/);
  assert.match(sharedCard, /sharedRoomEnterDelayMs\(index, MOTION\.chipStagger\)/);
  assert.doesNotMatch(sharedCard, /useNativeDriver: false/);
});

test('shared card list passes a stable per-card index for staggered entrance', () => {
  assert.match(screen, /rooms\.map\(\(room, index\) => \(/);
  assert.match(screen, /<SharedRoomCard[\s\S]*?index=\{index\}/);
});

test('loading state shows decorative, non-animated skeleton cards hidden from screen readers', () => {
  const skeletonComponent = screen.match(
    /function SharedRoomSkeletonCard\([\s\S]*?function SharedWithMeSection/,
  )?.[0] ?? '';
  assert.ok(skeletonComponent.length > 50, 'SharedRoomSkeletonCard found');
  assert.match(skeletonComponent, /accessibilityElementsHidden/);
  assert.match(skeletonComponent, /importantForAccessibility="no-hide-descendants"/);
  assert.match(skeletonComponent, /styles\.skeletonBlock/);
  assert.doesNotMatch(skeletonComponent, /Animated\./);
  assert.match(screen, /<SharedRoomSkeletonCard style=\{styles\.gridItem\} \/>/);
});

test('skeleton cards render only during initial loading, not alongside real rooms', () => {
  const loadingBlock = screen.match(
    /\{presentation\.showLoading \? \([\s\S]*?\) : null\}/,
  )?.[0] ?? '';
  assert.ok(loadingBlock.length > 20, 'showLoading block found');
  assert.match(loadingBlock, /SharedRoomSkeletonCard/);
  const roomsBlock = screen.match(
    /\{presentation\.showRooms \? \([\s\S]*?\) : null\}/,
  )?.[0] ?? '';
  assert.doesNotMatch(roomsBlock, /SharedRoomSkeletonCard/);
});
