// Route reachability: every shipping screen must have a real entry point.
//
// /looks regressed into a write-only feature. A Look is created from a Dressing
// Room, which pushes straight to /looks/<id>. The only navigation to the /looks
// list was router.replace('/looks') from inside that detail screen after a
// delete — so once the user left, their saved Looks were unreachable, even
// though the data persisted server-side and the list screen was fully built.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const NAVIGATION_SOURCES = [
  'app.js',
  'app/index.tsx',
  'app/library.tsx',
  'app/privacy.tsx',
  'app/looks/index.tsx',
  'app/looks/[id].tsx',
  'app/dressing-rooms/index.tsx',
  'app/dressing-rooms/[id].tsx',
  'app/style-chat/index.tsx',
  'app/style-chat/[sessionId].tsx',
  'app/(public)/rooms/[token].tsx',
];

function readAll() {
  return NAVIGATION_SOURCES.map((relative) => ({
    relative,
    source: fs.readFileSync(path.join(ROOT, relative), 'utf8'),
  }));
}

/**
 * Screens that navigate to `route` from somewhere other than `route` itself or
 * its own detail screen. A feature whose only inbound link is its own subtree is
 * not reachable.
 */
function externalEntryPoints(route, ownSubtree) {
  const pattern = new RegExp(`router\\.(push|replace)\\(\\s*['"\`]${route}['"\`]`);
  return readAll()
    .filter(({ relative }) => !ownSubtree.some((own) => relative.startsWith(own)))
    .filter(({ source }) => pattern.test(source))
    .map(({ relative }) => relative);
}

test('Saved Looks is reachable from outside its own subtree', () => {
  const entries = externalEntryPoints('/looks', ['app/looks/']);
  assert.ok(
    entries.length > 0,
    'a saved Look must remain reachable after the session that created it',
  );
});

test('the Saved Looks entry sits where Looks are created', () => {
  const rooms = fs.readFileSync(path.join(ROOT, 'app', 'dressing-rooms', 'index.tsx'), 'utf8');
  assert.match(rooms, /router\.push\('\/looks'\)/);
  assert.match(rooms, /accessibilityLabel="Saved Looks"/);
  assert.match(
    rooms,
    /isFeatureEnabled\('outfitRemixLooks'\)/,
    'the entry must honour the same flag that gates the Looks screen itself',
  );
});

test('every primary screen has an inbound navigation path', () => {
  const routes = [
    { route: '/scan', ownSubtree: ['app/scan/'] },
    { route: '/library', ownSubtree: ['app/library.tsx'] },
    { route: '/dressing-rooms', ownSubtree: ['app/dressing-rooms/'] },
    { route: '/style-chat', ownSubtree: ['app/style-chat/'] },
    { route: '/privacy', ownSubtree: ['app/privacy.tsx'] },
    { route: '/looks', ownSubtree: ['app/looks/'] },
  ];

  const unreachable = routes
    .filter(({ route, ownSubtree }) => externalEntryPoints(route, ownSubtree).length === 0)
    .map(({ route }) => route);

  assert.deepEqual(unreachable, [], `no inbound navigation for: ${unreachable.join(', ')}`);
});
