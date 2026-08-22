/**
 * Product-name branding regression guard.
 *
 * The user-facing product name is "K Scan AI" (exact capitalization). This
 * repo has two independent sources of truth for the native app label —
 * app.json (Expo config, used by both platforms) and the committed native
 * Android resource file — and a large set of screens/components that spell
 * the name out in user-visible copy (permission rationale, accessibility
 * labels, share/notification text, error/empty states).
 *
 * This is NOT a naive repo-wide grep: it only checks the specific
 * screens/components/config audited and migrated to "K Scan AI". Deliberate
 * exceptions (documented inline) are things like:
 *   - "K Scanner" — an unrelated whimsical fallback greeting name
 *     (Home screens), not the product name.
 *   - Technical identifiers: com.kscanai.app, kscan.app, Gradle project
 *     name, Supabase/edge-function/module names, console.log tags like
 *     "[K-SCAN]" — none of these are user-facing and are intentionally
 *     untouched by the branding migration.
 *   - Historical docs, frozen rollback snapshots, and test fixtures that
 *     intentionally preserve an older/unrelated string are out of scope.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

const CANONICAL_NAME = 'K Scan AI';

// Matches a bare "K Scan" that is NOT part of "K Scan AI" and NOT part of
// the unrelated "K Scanner" fallback name.
const BARE_K_SCAN = /K Scan(?!ner)(?!\s*AI)/;

// ─── Native app label parity (app.json <-> Android strings.xml) ────────────

test('app.json expo.name is the canonical product name', () => {
  const appJson = JSON.parse(read('app.json'));
  assert.equal(appJson.expo.name, CANONICAL_NAME);
});

test('Android app_name resource is the canonical product name', () => {
  const strings = read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const match = strings.match(/<string name="app_name">([^<]*)<\/string>/);
  assert.ok(match, 'app_name string must be present in strings.xml');
  assert.equal(match[1], CANONICAL_NAME);
});

test('app.json and Android strings.xml do not diverge on the app label', () => {
  const appJson = JSON.parse(read('app.json'));
  const strings = read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const match = strings.match(/<string name="app_name">([^<]*)<\/string>/);
  assert.ok(match, 'app_name string must be present in strings.xml');
  assert.equal(
    appJson.expo.name,
    match[1],
    'app.json expo.name and Android app_name must be kept in sync',
  );
});

test('app.json permission rationale strings use the canonical product name', () => {
  const appJson = JSON.parse(read('app.json'));
  const cameraPermission = appJson.expo.plugins.find(
    (p) => Array.isArray(p) && p[0] === 'expo-camera',
  )[1].cameraPermission;
  const photosPermission = appJson.expo.plugins.find(
    (p) => Array.isArray(p) && p[0] === 'expo-image-picker',
  )[1].photosPermission;
  const locationPermission = appJson.expo.plugins.find(
    (p) => Array.isArray(p) && p[0] === 'expo-location',
  )[1].locationWhenInUsePermission;

  assert.ok(cameraPermission.startsWith(CANONICAL_NAME));
  assert.ok(photosPermission.startsWith(CANONICAL_NAME));
  assert.ok(locationPermission.startsWith(CANONICAL_NAME));

  assert.equal(appJson.expo.ios.infoPlist.NSCameraUsageDescription, cameraPermission);
  assert.equal(appJson.expo.ios.infoPlist.NSPhotoLibraryUsageDescription, photosPermission);
  assert.equal(appJson.expo.ios.infoPlist.NSLocationWhenInUseUsageDescription, locationPermission);
});

// ─── Curated user-facing surfaces: no stray un-migrated "K Scan" ───────────
//
// Every file below is a screen/component/config that was audited for
// user-visible copy (rendered text, accessibilityLabel/Hint, Alert copy,
// Share payloads) and had every such occurrence migrated to "K Scan AI".
// A bare "K Scan" reappearing here means a regression (a hardcoded string
// was reverted, or new copy was added without the "AI" suffix).

const AUDITED_USER_FACING_FILES = [
  ['app.js'],
  ['app', '_layout.tsx'],
  ['app', 'privacy.tsx'],
  ['app', 'onboarding', 'index.tsx'],
  ['app', 'library.tsx'],
  ['app', 'looks', '[id].tsx'],
  ['app', 'auth', 'index.tsx'],
  ['app', 'auth', 'reset.tsx'],
  ['app', 'auth', 'update-password.tsx'],
  ['app', 'auth', 'callback.tsx'],
  ['app', 'dressing-rooms', '[id].tsx'],
  ['app', 'dressing-rooms', 'index.tsx'],
  ['app', '(public)', 'rooms', '[token].tsx'],
  ['components', 'account-home', 'WelcomeStepV1.tsx'],
  ['components', 'account-home', 'AccountSetupStepV1.tsx'],
  ['components', 'account-home', 'PermissionsStepV1.tsx'],
  ['components', 'stylist', 'PersonalizeStylistModal.tsx'],
  ['components', 'style-chat', 'StyleChatPhotoIntake.tsx'],
  ['components', 'scan-room', 'ScanLanding.tsx'],
  ['components', 'scan-room', 'LiveScanCamera.tsx'],
  ['components', 'scan-room', 'CaptureReview.tsx'],
  ['components', 'scan-room', 'AnalyzingScan.tsx'],
  ['components', 'scan-room', 'ScanRoomHeader.tsx'],
  ['components', 'scan-results', 'ScanResultV2.tsx'],
  ['components', 'scan-results', 'StyleAnalysisSection.tsx'],
  ['components', 'closet', 'MirrorSelfieExtractionModal.tsx'],
  ['components', 'closet', 'ClosetIntakeModal.tsx'],
  ['components', 'dressing-rooms', 'RoomItemDetailModal.tsx'],
  ['components', 'StyleObjectCards.tsx'],
  ['components', 'ProductShelf.tsx'],
  ['components', 'AnalysisCard.tsx'],
  ['components', 'luxury', 'KScanHeader.tsx'],
  ['components', 'luxury', 'ProductCard.tsx'],
  ['components', 'glasses', 'GlassesPrototypeScreen.tsx'],
  ['src', 'components', 'ErrorBoundary.tsx'],
  ['hooks', 'useShareOutfit.ts'],
  ['services', 'free-tier', 'shareTextBuilder.ts'],
  ['services', 'privateDressingRoomCoordinator.ts'],
  ['services', 'privateSavedLookCopy.ts'],
  ['services', 'closetLibrary.js'],
  ['services', 'textScan.ts'],
  ['services', 'textScanEdge.ts'],
  ['components', 'home', 'HomeV2.tsx'],
];

for (const segments of AUDITED_USER_FACING_FILES) {
  const relPath = segments.join('/');
  test(`no un-migrated "K Scan" copy in ${relPath}`, () => {
    const content = read(...segments);
    assert.doesNotMatch(
      content,
      BARE_K_SCAN,
      `${relPath} contains a bare "K Scan" that should read "K Scan AI"`,
    );
  });
}

// These two Home screens intentionally keep the unrelated "K Scanner"
// fallback greeting name (a pun on the product name used as a stand-in for
// a missing user name, not the product name itself), so they are checked
// with the "ner" exception active (already applied via BARE_K_SCAN above)
// rather than being skipped outright. HomeV2.tsx uses a different greeting
// with no such fallback, so it is covered by the general list above instead.
const HOME_SCREENS = [
  ['components', 'home', 'HomeLuxuryTechV1.tsx'],
  ['components', 'home', 'HomeLegacy.tsx'],
];

for (const segments of HOME_SCREENS) {
  const relPath = segments.join('/');
  test(`no un-migrated "K Scan" copy in ${relPath} (K Scanner fallback excluded)`, () => {
    const content = read(...segments);
    assert.doesNotMatch(
      content,
      BARE_K_SCAN,
      `${relPath} contains a bare "K Scan" that should read "K Scan AI"`,
    );
    // Sanity check the exception itself still exists and is spelled as
    // expected, so a typo there can't silently widen the exception.
    assert.match(content, /K Scanner/);
  });
}

// ─── Specific high-value assertions (native label, wordmark, share text) ──

test('KScanHeader default brand mark is the canonical product name', () => {
  const header = read('components', 'luxury', 'KScanHeader.tsx');
  assert.match(header, /brandLabel = 'K Scan AI'/);
});

test('share watermark and canonical share copy use the full product name', () => {
  const shareTextBuilder = read('services', 'free-tier', 'shareTextBuilder.ts');
  assert.match(shareTextBuilder, /SHARE_WATERMARK = 'Styled with K Scan AI'/);
  assert.match(shareTextBuilder, /Check out this look I saved in K Scan AI/);
});

test('AI stylist system prompts identify as the canonical product name', () => {
  const stylechatGenerate = read('supabase', 'functions', 'stylechat-generate', 'index.ts');
  const styleOutfitGenerate = read('supabase', 'functions', 'style-outfit-generate', 'index.ts');
  assert.match(stylechatGenerate, /You are K Scan AI's personal AI fashion stylist/);
  assert.match(styleOutfitGenerate, /You are K Scan AI's outfit stylist/);
});
