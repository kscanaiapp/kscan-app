// Platform-parity contract tests (AI Stylist expansion).
// All new feature surfaces must be shared React Native implementations with
// no Platform.OS gate that excludes either platform.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const NEW_FEATURE_FILES = [
  'app/stylist/index.tsx',
  'app/looks/create.tsx',
  'components/looks/AskMyRoomModal.tsx',
  'components/dressing-rooms/OutfitDecisionSection.tsx',
  'services/ownedClosetItems.ts',
  'services/outfitDecisions.ts',
  'services/styleOutfits.ts',
  'services/styleMemoryEvents.ts',
  'hooks/useOwnedClosetItems.ts',
  'types/ownedClosetItem.ts',
  'types/fashionReasoning.ts',
];

test('no iOS or Android exclusion gates in new feature files', () => {
  for (const file of NEW_FEATURE_FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(
      !/Platform\.OS\s*[=!]==?\s*['"](ios|android)['"]/.test(source),
      `${file} contains a platform exclusion gate`,
    );
    assert.ok(!/Platform\.select/.test(source), `${file} uses Platform.select`);
  }
});

test('new routes exist and are shared (single route file per surface)', () => {
  for (const route of ['app/stylist/index.tsx', 'app/looks/create.tsx']) {
    assert.ok(fs.existsSync(path.join(ROOT, route)), `${route} missing`);
    assert.ok(!fs.existsSync(path.join(ROOT, route.replace('.tsx', '.ios.tsx'))), `${route} has iOS fork`);
    assert.ok(!fs.existsSync(path.join(ROOT, route.replace('.tsx', '.android.tsx'))), `${route} has Android fork`);
  }
});

test('both platforms share the same feature flag and freeze key', () => {
  const flags = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');
  assert.match(flags, /'aiStylist',/);
  assert.match(flags, /EXPO_PUBLIC_AI_STYLIST_ENABLED/);
  // Every gated surface reads the same constants.
  for (const file of ['app/stylist/index.tsx', 'app/looks/create.tsx', 'app/library.tsx', 'app/looks/index.tsx']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(source.includes('AI_STYLIST_UI_ENABLED'), `${file} does not use the shared flag`);
  }
});

test('variation order, quotas, and privacy boundaries live in shared contracts', () => {
  const mobile = fs.readFileSync(path.join(ROOT, 'types', 'fashionReasoning.ts'), 'utf8');
  assert.match(mobile, /'reliable',\s*'elevated',\s*'something_different'/);
  const service = fs.readFileSync(path.join(ROOT, 'services', 'styleOutfits.ts'), 'utf8');
  assert.match(service, /UNAVAILABLE_COOLDOWN_MS = 30_000/);
});

test('release configuration untouched (protected paths)', () => {
  // The feature must not alter app identity, versions, or native permissions.
  const appJson = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8');
  assert.doesNotMatch(appJson, /aiStylist|style-outfit/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!('jest' in (packageJson.devDependencies ?? {})), 'jest must not be added');
  assert.ok(!('vitest' in (packageJson.devDependencies ?? {})), 'vitest must not be added');
});
