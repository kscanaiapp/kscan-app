const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// Routes for features that are intentionally excluded from the iOS release.
// Each must surface SafeUnavailableScreen on iOS so a deep link can never show
// the feature or trigger its backend calls.
const EXCLUDED_ROUTE_FILES = [
  'app/style-chat/index.tsx',
  'app/style-chat/[sessionId].tsx',
  'app/style-chat/debug-memory.tsx',
  'app/dressing-rooms/index.tsx',
  'app/dressing-rooms/[id].tsx',
  'app/looks/index.tsx',
  'app/looks/[id].tsx',
  'app/(public)/rooms/[token].tsx',
];

test('SafeUnavailableScreen exists with calm, reviewer-safe copy', () => {
  const source = read('components/SafeUnavailableScreen.tsx');
  assert.match(source, /This feature is not part of this iOS release\./);
  // No roadmap / marketing language.
  assert.doesNotMatch(source, /coming soon|next release|roadmap/i);
});

for (const file of EXCLUDED_ROUTE_FILES) {
  test(`${file} guards the route on iOS with SafeUnavailableScreen`, () => {
    const source = read(file);
    assert.match(
      source,
      /import SafeUnavailableScreen from/,
      'expected SafeUnavailableScreen import',
    );
    assert.match(
      source,
      /if \(Platform\.OS === 'ios'\) \{\s*return <SafeUnavailableScreen \/>;/,
      'expected an iOS guard that returns SafeUnavailableScreen',
    );
  });
}

test('Home hides StyleChat and Dressing Rooms entry points on iOS', () => {
  const source = read('app/index.tsx');
  // The StyleChat entry card and Dressing Rooms card are gated to non-iOS.
  assert.match(source, /Platform\.OS !== 'ios'/);
  assert.doesNotMatch(source, /coming soon|next release/i);
});

test('Library never wires the Dressing Room action on iOS', () => {
  const source = read('app/library.tsx');
  assert.match(
    source,
    /dressingRoomsEnabled\s*=\s*[\s\S]*Platform\.OS !== 'ios'/,
    'expected dressingRoomsEnabled to require non-iOS',
  );
});

test('Library skips the inspiration backend fetch on iOS', () => {
  const source = read('app/library.tsx');
  assert.match(
    source,
    /if \(!isAuthenticated \|\| Platform\.OS === 'ios'\) return;/,
    'expected loadInspirations to early-return on iOS',
  );
});
