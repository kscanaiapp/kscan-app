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

test('refresh failures remain controlled and do not erase the current room image state', () => {
  const reloadCatch = roomScreen.slice(
    roomScreen.indexOf('} catch (err: any) {', roomScreen.indexOf('const reload = useCallback')),
    roomScreen.indexOf('} finally {', roomScreen.indexOf('const reload = useCallback')),
  );
  assert.match(reloadCatch, /setError\(DRESSING_ROOM_LOAD_ERROR\)/);
  assert.doesNotMatch(reloadCatch, /setItems\(\[\]\)|setInspirations\(\[\]\)/);
});
