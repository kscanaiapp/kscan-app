const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const roomScreen = fs.readFileSync(
  path.join(ROOT, 'app/dressing-rooms/[id].tsx'),
  'utf8',
);
const service = fs.readFileSync(path.join(ROOT, 'services/styleObjects.ts'), 'utf8');

test('screen focus and app foreground re-run the authoritative room loaders', () => {
  assert.match(roomScreen, /useFocusEffect\(useCallback\(\(\) => \{[\s\S]*void reload\(\);[\s\S]*void loadInspirations\(\)/);
  assert.match(roomScreen, /AppState\.addEventListener\('change',[\s\S]*nextState !== 'active'[\s\S]*void reload\(\);[\s\S]*void loadInspirations\(\)/);
});

test('identical focus and foreground requests are deduped while actor and room changes can supersede them', () => {
  assert.match(roomScreen, /roomLoadInFlightKey\.current === requestKey/);
  assert.match(roomScreen, /inspirationLoadInFlightKey\.current === requestKey/);
  assert.match(roomScreen, /requestKey = `\$\{requestedActorId \?\? 'anonymous'\}:\$\{roomId\}`/);
  assert.match(roomScreen, /requestId !== roomLoadRequestId\.current/);
  assert.match(roomScreen, /activeActorIdRef\.current !== requestedActorId/);
  assert.match(roomScreen, /activeRoomIdRef\.current !== roomId/);
});

test('blur invalidates pending room and inspiration responses', () => {
  const focusBlock = roomScreen.slice(
    roomScreen.indexOf('useFocusEffect(useCallback'),
    roomScreen.indexOf('const reactionItemIds'),
  );
  assert.match(focusBlock, /roomLoadRequestId\.current \+= 1/);
  assert.match(focusBlock, /inspirationLoadRequestId\.current \+= 1/);
  assert.match(focusBlock, /roomLoadInFlightKey\.current = null/);
  assert.match(focusBlock, /inspirationLoadInFlightKey\.current = null/);
});

test('canonical bucket and path remain database truth and signed URLs are resolved transiently', () => {
  assert.match(service, /storageBucket: row\.storage_bucket/);
  assert.match(service, /storagePath: row\.storage_path/);
  assert.match(service, /imageUrl: null/);
  assert.match(service, /createSignedStorageUrl\(item\.storageBucket, item\.storagePath\)/);
  assert.doesNotMatch(service, /storage_path:\s*signedUrl/);
});

// The reload catch now has two paths. A TRANSIENT failure must still leave the
// room on screen (the original property this test defends). An AUTHORIZATION
// LOSS must do the opposite and flush everything, because the access-revoked
// state must not be a frame around cached room content. Asserting on the whole
// catch block could no longer tell the two apart, so each is checked in the
// region it belongs to.
function reloadCatchRegions() {
  const reloadStart = roomScreen.indexOf('const reload = useCallback');
  const reloadCatch = roomScreen.slice(
    roomScreen.indexOf('} catch (err: any) {', reloadStart),
    roomScreen.indexOf('} finally {', reloadStart),
  );
  const lostAccessAt = reloadCatch.indexOf('if (lostAccess) {');
  const transientAt = reloadCatch.indexOf('setError(DRESSING_ROOM_LOAD_ERROR)');
  return {
    reloadCatch,
    accessLostBranch: reloadCatch.slice(lostAccessAt, transientAt),
    transientPath: reloadCatch.slice(transientAt),
  };
}

test('refresh failures remain controlled and do not erase the current room image state', () => {
  const { transientPath } = reloadCatchRegions();
  assert.match(transientPath, /setError\(DRESSING_ROOM_LOAD_ERROR\)/);
  assert.doesNotMatch(transientPath, /setItems\(\[\]\)|setInspirations\(\[\]\)/);
});

test('an authorization loss flushes room state instead of leaving it on screen', () => {
  const { reloadCatch, accessLostBranch } = reloadCatchRegions();
  assert.ok(accessLostBranch.length > 0, 'the access-loss branch must exist');
  assert.match(accessLostBranch, /setAccessLost\(true\)/);
  assert.match(accessLostBranch, /setItems\(\[\]\)/);
  assert.match(accessLostBranch, /setInspirations\(\[\]\)/);
  assert.match(accessLostBranch, /setRoom\(null\)/);
  // And the flushes live ONLY there: one occurrence each in the whole catch.
  assert.equal((reloadCatch.match(/setItems\(\[\]\)/g) || []).length, 1);
  assert.equal((reloadCatch.match(/setInspirations\(\[\]\)/g) || []).length, 1);
});
