const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const publicRoomScreen = fs.readFileSync(path.join(ROOT, 'app/(public)/rooms/[token].tsx'), 'utf8');
const captureService = fs.readFileSync(path.join(ROOT, 'services/captureSharedRoomMembership.ts'), 'utf8');
const membershipService = fs.readFileSync(path.join(ROOT, 'services/sharedRoomMemberships.ts'), 'utf8');

test('public route imports the shared membership capture helper', () => {
  assert.match(publicRoomScreen, /captureSharedRoomMembershipAfterPreview/);
  assert.match(publicRoomScreen, /createMembershipCaptureAttemptTracker/);
});

test('capture happens only after preview validation phases', () => {
  assert.match(
    publicRoomScreen,
    /if \(state\.phase !== 'available' && state\.phase !== 'empty'\) return;/,
  );
  assert.match(publicRoomScreen, /previewStatus: state\.phase/);
});

test('membership capture is a non-blocking side effect', () => {
  const captureEffect = publicRoomScreen.match(
    /Account-anchored Shared with Me capture:[\s\S]*?\}, \[authLoading, isAuthenticated, rawToken, state\.phase, user\?\.id\]\);/,
  )?.[0] ?? '';
  assert.ok(captureEffect.length > 0, 'membership capture effect found');
  assert.match(captureEffect, /void captureSharedRoomMembershipAfterPreview\(/);
  assert.doesNotMatch(captureEffect, /setState/);
});

test('membership result does not control room-access state', () => {
  assert.doesNotMatch(publicRoomScreen, /saveSharedRoomForCurrentUser/);
  assert.doesNotMatch(publicRoomScreen, /membership.*setState|setState.*membership/i);
});

test('membership capture is not tied to image-resolution success', () => {
  const captureEffect = publicRoomScreen.match(
    /Account-anchored Shared with Me capture:[\s\S]*?\}, \[authLoading, isAuthenticated, rawToken, state\.phase, user\?\.id\]\);/,
  )?.[0] ?? '';
  assert.ok(captureEffect.length > 0, 'membership capture effect found');
  assert.doesNotMatch(captureEffect, /resolvedImageUrls/);
  assert.doesNotMatch(captureEffect, /resolveSharedRoomImageUrls/);
});

test('browser behavior remains gated inside the capture helper', () => {
  assert.match(captureService, /if \(input\.platform === 'web'\) return false;/);
});

test('no iOS/Android split exists for membership capture', () => {
  assert.doesNotMatch(publicRoomScreen, /Platform\.OS === 'ios'[\s\S]*saveSharedRoom/);
  assert.doesNotMatch(publicRoomScreen, /Platform\.OS === 'android'[\s\S]*saveSharedRoom/);
  assert.match(publicRoomScreen, /platform: Platform\.OS/);
});

test('membership service reuses the canonical token normalizer', () => {
  assert.match(membershipService, /normalizeRoomShareToken/);
  assert.doesNotMatch(membershipService, /normalizeTokenInput\([\s\S]*toLowerCase/);
  assert.doesNotMatch(membershipService, /p_share_token:[\s\S]*toLowerCase/);
});

test('membership service uses RPC-only backend contract', () => {
  assert.match(membershipService, /save_shared_room_for_me/);
  assert.match(membershipService, /list_shared_rooms_for_me/);
  assert.match(membershipService, /touch_shared_room_for_me/);
  assert.match(membershipService, /remove_shared_room_for_me/);
  assert.doesNotMatch(membershipService, /AsyncStorage/);
  assert.doesNotMatch(membershipService, /from\('shared_room_memberships'\)/);
});

test('auth timing waits for loading to resolve before capture eligibility', () => {
  assert.match(publicRoomScreen, /authLoading[\s\S]*phase: 'loading'/);
  assert.match(publicRoomScreen, /isAuthenticated && user\?\.id[\s\S]*phase: 'authenticated'/);
});

test('attempt tracker resets on token and user changes', () => {
  assert.match(publicRoomScreen, /membershipCaptureTracker\.current\.reset\(\)/);
  assert.match(
    publicRoomScreen,
    /membershipCaptureTracker\.current\.reset\(\);\s+\}, \[rawToken\]\);/,
  );
  assert.match(
    publicRoomScreen,
    /useEffect\(\(\) => \{\s+membershipCaptureTracker\.current\.reset\(\);\s+\}, \[user\?\.id\]\);/,
  );
});
