/**
 * Product-identity rename guard: "K Scan" -> "K Scan AI".
 *
 * Repo convention for screen-level UI is static source-text assertion (see
 * __tests__/onboardingAiConsent.test.js, __tests__/sourceEncodingIntegrity.test.js)
 * rather than a React render, since neither Jest nor RTL is installed.
 *
 * This guards the two canonical app-identity fields plus a curated list of
 * the user-facing surfaces audited during the Build 31 "K Scan AI" branding
 * pass (screens, accessibility labels, alerts, share/notification copy).
 * It intentionally does NOT grep the whole repo: technical identifiers
 * (kscan.app, com.kscanai.app, the `useKScan`/`KScanHeader`/`KScanIcon`
 * symbols, Supabase project names, migration files, historical docs, and
 * fixture data such as "K Scan Demo Catalog" or "K Scan Atelier") are
 * legitimately allowed to keep the un-suffixed name, and a naive repo-wide
 * check would both false-positive on those and miss that this is a curated
 * allowlist of *known* user-facing strings, not a hunt for new ones.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('app.json Expo display name is "K Scan AI"', () => {
  const appJson = JSON.parse(readFile('app.json'));
  assert.equal(appJson.expo.name, 'K Scan AI');
});

test('app.json iOS permission usage descriptions carry the "K Scan AI" name', () => {
  const appJson = JSON.parse(readFile('app.json'));
  const infoPlist = appJson.expo.ios.infoPlist;
  assert.match(infoPlist.NSCameraUsageDescription, /^K Scan AI /);
  assert.match(infoPlist.NSPhotoLibraryUsageDescription, /^K Scan AI /);
  assert.match(infoPlist.NSLocationWhenInUseUsageDescription, /^K Scan AI /);
});

test('store.config.json App Store listing uses "K Scan AI"', () => {
  const storeConfig = JSON.parse(readFile('store.config.json'));
  const info = storeConfig.apple.info['en-US'];
  assert.equal(info.title, 'K Scan AI');
  assert.match(info.description, /^K Scan AI helps you/);
  assert.match(info.description, /K Scan AI is not a retailer or marketplace/);
});

test('KScanHeader default brand mark renders "K Scan AI" (HomeV2 and HomeLegacy rely on this default)', () => {
  const source = readFile('components/luxury/KScanHeader.tsx');
  assert.match(source, /brandLabel = 'K Scan AI'/);
});

// ─── Curated user-facing surface scan ──────────────────────────────────────
//
// Each entry is a file that renders literal "K Scan" copy to a user (screen
// text, accessibility label/hint, alert, share sheet, or notification copy).
// allowedBareExceptions lists exact trimmed lines that are permitted to keep
// a standalone "K Scan" — always a source-comment, never rendered text.

const AUDITED_SURFACES = [
  { file: 'app.js', allowedBareExceptions: [] },
  { file: 'app/_layout.tsx', allowedBareExceptions: [] },
  { file: 'app/auth/index.tsx', allowedBareExceptions: [] },
  { file: 'app/library.tsx', allowedBareExceptions: [] },
  { file: 'app/looks/[id].tsx', allowedBareExceptions: [] },
  { file: 'app/onboarding/index.tsx', allowedBareExceptions: [] },
  { file: 'app/privacy.tsx', allowedBareExceptions: [] },
  { file: 'app/dressing-rooms/index.tsx', allowedBareExceptions: [] },
  // K+ Packing Intelligence V1 surfaces. Added with the feature so its copy
  // is covered by this gate from its first commit rather than after a
  // reviewer notices a bare product name in a shipped screen.
  { file: 'app/packing/index.tsx', allowedBareExceptions: [] },
  { file: 'components/packing/PackingPlanView.tsx', allowedBareExceptions: [] },
  { file: 'components/packing/PackingTripForm.tsx', allowedBareExceptions: [] },
  { file: 'app/dressing-rooms/[id].tsx', allowedBareExceptions: [] },
  { file: 'app/(public)/rooms/[token].tsx', allowedBareExceptions: [] },
  { file: 'components/AnalysisCard.tsx', allowedBareExceptions: [] },
  { file: 'components/ProductShelf.tsx', allowedBareExceptions: [] },
  { file: 'components/account-home/AccountSetupStepV1.tsx', allowedBareExceptions: [] },
  {
    file: 'components/account-home/WelcomeStepV1.tsx',
    allowedBareExceptions: ['* - K Scan brand header'],
  },
  { file: 'components/account-home/PermissionsStepV1.tsx', allowedBareExceptions: [] },
  { file: 'components/closet/ClosetIntakeModal.tsx', allowedBareExceptions: [] },
  { file: 'components/closet/MirrorSelfieExtractionModal.tsx', allowedBareExceptions: [] },
  { file: 'components/glasses/GlassesPrototypeScreen.tsx', allowedBareExceptions: [] },
  { file: 'components/home/HomeLegacy.tsx', allowedBareExceptions: [] },
  { file: 'components/home/HomeLuxuryTechV1.tsx', allowedBareExceptions: [] },
  { file: 'components/home/HomeV2.tsx', allowedBareExceptions: [] },
  {
    file: 'components/luxury/KScanHeader.tsx',
    allowedBareExceptions: ['* A premium editorial header for K Scan screens.'],
  },
  { file: 'components/luxury/ProductCard.tsx', allowedBareExceptions: [] },
  { file: 'components/rooms/RoomMessagesPanel.tsx', allowedBareExceptions: [] },
  { file: 'components/scan-results/ScanResultV2.tsx', allowedBareExceptions: [] },
  { file: 'components/scan-results/StyleAnalysisSection.tsx', allowedBareExceptions: [] },
  { file: 'components/scan-room/AnalyzingScan.tsx', allowedBareExceptions: [] },
  { file: 'components/scan-room/CaptureReview.tsx', allowedBareExceptions: [] },
  { file: 'components/scan-room/LiveScanCamera.tsx', allowedBareExceptions: [] },
  { file: 'components/scan-room/ScanLanding.tsx', allowedBareExceptions: [] },
  { file: 'components/scan-room/ScanRoomHeader.tsx', allowedBareExceptions: [] },
  { file: 'components/style-chat/EliseVisualSourceMenu.tsx', allowedBareExceptions: [] },
  { file: 'components/style-chat/StyleChatAttachmentBar.tsx', allowedBareExceptions: [] },
  { file: 'components/style-chat/StyleChatPhotoIntake.tsx', allowedBareExceptions: [] },
  { file: 'components/stylist/PersonalizeStylistModal.tsx', allowedBareExceptions: [] },
  { file: 'constants/styleChatPrompts.ts', allowedBareExceptions: [] },
  { file: 'constants/weatherStyling.ts', allowedBareExceptions: [] },
  { file: 'data/scan-results-demo.ts', allowedBareExceptions: [] },
  { file: 'hooks/useEliseVisualContext.ts', allowedBareExceptions: [] },
  { file: 'hooks/usePermissionPreferences.ts', allowedBareExceptions: [] },
  { file: 'hooks/useShareOutfit.ts', allowedBareExceptions: [] },
  { file: 'services/closetLibrary.js', allowedBareExceptions: [
    '* K Scan Closet — durable, actor-scoped device-local owned-inventory store.',
  ] },
  { file: 'services/free-tier/shareTextBuilder.ts', allowedBareExceptions: [
    '* devices with K Scan installed this opens the app first, with the website',
  ] },
  { file: 'services/privateDressingRoomCoordinator.ts', allowedBareExceptions: [] },
  { file: 'services/privateSavedLookCopy.ts', allowedBareExceptions: [] },
  { file: 'services/reportAiOutput.ts', allowedBareExceptions: [] },
  { file: 'services/textScan.ts', allowedBareExceptions: [] },
  { file: 'services/textScanEdge.ts', allowedBareExceptions: [] },
  { file: 'src/components/ErrorBoundary.tsx', allowedBareExceptions: [] },
  { file: 'supabase/functions/handle-user-deletion/index.ts', allowedBareExceptions: [] },
];

// Matches "K Scan" or "K SCAN" as a whole word, so it does not fire on the
// intentional "K Scanner" username-fallback pun (signup name resolver) or on
// no-space technical identifiers like KScanHeader/useKScan/KScanIcon.
const BARE_NAME_PATTERN = /\bK (?:Scan|SCAN)\b(?! AI\b)/;

function findBareOccurrences(source, allowedBareExceptions) {
  const allowed = new Set(allowedBareExceptions);
  const violations = [];
  source.split('\n').forEach((line, index) => {
    if (!BARE_NAME_PATTERN.test(line)) return;
    if (allowed.has(line.trim())) return;
    violations.push(`line ${index + 1}: ${line.trim()}`);
  });
  return violations;
}

test('audited user-facing surfaces list at least the known screens/components', () => {
  // A cheap tripwire so a future edit that deletes an entry silently doesn't
  // shrink coverage without anyone noticing.
  assert.ok(AUDITED_SURFACES.length >= 45, 'audited surface list must not shrink');
});

for (const { file, allowedBareExceptions } of AUDITED_SURFACES) {
  test(`no un-suffixed "K Scan" renders from ${file}`, () => {
    const source = readFile(file);
    const violations = findBareOccurrences(source, allowedBareExceptions);
    assert.deepEqual(
      violations,
      [],
      `${file} has bare "K Scan" text that should read "K Scan AI":\n${violations.join('\n')}`,
    );
  });
}

test('the "K Scanner" fallback greeting pun is untouched by the rename (not the product name)', () => {
  const homeLegacy = readFile('components/home/HomeLegacy.tsx');
  const homeLuxury = readFile('components/home/HomeLuxuryTechV1.tsx');
  assert.match(homeLegacy, /'K Scanner'/);
  assert.match(homeLuxury, /'K Scanner'/);
});
