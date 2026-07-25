const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(
  path.join(ROOT, 'app/(public)/rooms/[token].tsx'),
  'utf8',
);
const resolver = fs.readFileSync(
  path.join(ROOT, 'services/sharedRoomImageResolver.ts'),
  'utf8',
);

test('authoritative preview refresh invalidates prior signed URLs and permits retry', () => {
  const refreshBlock = screen.slice(
    screen.indexOf('lastFetchedAt.current = Date.now()'),
    screen.indexOf('setState(result)') + 'setState(result)'.length,
  );
  assert.match(refreshBlock, /setResolvedImageUrls\(\{\}\)/);
  assert.match(refreshBlock, /imageResolutionGuard\.current = null/);
  assert.ok(refreshBlock.indexOf('imageResolutionGuard.current = null') < refreshBlock.indexOf('setState(result)'));
});

test('server-side storage identity changes re-resolve after refresh without entering the public preview', () => {
  assert.match(screen, /setResolvedImageUrls\(\{\}\)[\s\S]*imageResolutionGuard\.current = null/);
  assert.doesNotMatch(screen, /item\.imageStorage(?:Bucket|Path)/);
  assert.doesNotMatch(resolver, /body: \{[^}]*storage(?:Bucket|Path)/);
});

test('guard identity includes typed unresolved item refs so same-count changed previews can resolve', () => {
  assert.match(screen, /itemRefsNeedingResolution[\s\S]*\.map\(getSharedRoomImageKey\)[\s\S]*\.sort\(\)/);
  assert.doesNotMatch(screen, /const key = `\$\{shareToken\}:\$\{state\.preview\.items\.length\}`/);
});

test('unchanged preview rerenders stay deduped and failed resolution can retry after refresh', () => {
  assert.match(screen, /if \(imageResolutionGuard\.current === key\) return/);
  assert.match(screen, /imageResolutionGuard\.current = key/);
  assert.match(resolver, /if \(error\)[\s\S]*return \{\}/);
  assert.match(screen, /setResolvedImageUrls\(\{\}\)[\s\S]*imageResolutionGuard\.current = null/);
});

test('unavailable previews never invoke image resolution and stale results are discarded', () => {
  assert.match(screen, /if \(!shareToken \|\| state\.phase !== 'available'\) return/);
  assert.match(screen, /let cancelled = false/);
  assert.match(screen, /if \(!cancelled\)[\s\S]*setResolvedImageUrls/);
  assert.match(screen, /return \(\) => \{[\s\S]*cancelled = true/);
});

test('client sends no private storage coordinates and renders only typed resolver output', () => {
  assert.match(resolver, /body: \{ shareToken, itemRefs \}/);
  assert.doesNotMatch(resolver, /storagePath|storageBucket/);
  assert.match(screen, /item\.imageUrl \?\? resolvedImageUrls\[imageKey\]/);
});
