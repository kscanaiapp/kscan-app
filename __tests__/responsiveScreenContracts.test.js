const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const appJson = JSON.parse(read('app.json'));
const easJson = JSON.parse(read('eas.json'));

// Screens whose layout must react to the live window. A module-scope
// Dimensions.get('window') is captured once at import and never updates, so
// rotation and Split View resizes would leave grids sized for the launch
// geometry.
const RESPONSIVE_SCREENS = [
  'app/library.tsx',
  'app/looks/index.tsx',
  'app/dressing-rooms/[id].tsx',
  'app/(public)/rooms/[token].tsx',
  'components/AnalysisCard.tsx',
  'components/scan-results/ScanResultV2.tsx',
];

// ── Tablet configuration ────────────────────────────────────────────────────

test('iPad support is enabled in the Expo config', () => {
  assert.equal(appJson.expo.ios.supportsTablet, true);
});

test('iPhone stays portrait-only while iPad gets all four orientations', () => {
  const infoPlist = appJson.expo.ios.infoPlist;
  assert.deepEqual(infoPlist.UISupportedInterfaceOrientations, ['UIInterfaceOrientationPortrait']);
  const ipad = infoPlist['UISupportedInterfaceOrientations~ipad'];
  assert.ok(Array.isArray(ipad));
  for (const orientation of [
    'UIInterfaceOrientationPortrait',
    'UIInterfaceOrientationPortraitUpsideDown',
    'UIInterfaceOrientationLandscapeLeft',
    'UIInterfaceOrientationLandscapeRight',
  ]) {
    assert.ok(ipad.includes(orientation), `iPad must support ${orientation}`);
  }
});

test('multitasking is not disabled by UIRequiresFullScreen', () => {
  assert.notEqual(appJson.expo.ios.infoPlist.UIRequiresFullScreen, true);
});

// ── Production Closet flags ─────────────────────────────────────────────────

test('Closet separation and direct intake are enabled in the production profile', () => {
  const env = easJson.build.production.env;
  assert.equal(env.EXPO_PUBLIC_CLOSET_SEPARATION_V1, 'true');
  assert.equal(env.EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1, 'true');
});

test('the production profile builds for the store and is not a preview profile', () => {
  assert.equal(easJson.build.production.distribution, 'store');
  assert.equal(easJson.cli.appVersionSource, 'remote');
});

// ── No stale module-scope geometry ──────────────────────────────────────────

test('responsive screens never capture window dimensions at module scope', () => {
  for (const file of RESPONSIVE_SCREENS) {
    const src = read(file);
    assert.doesNotMatch(
      src,
      /Dimensions\.get\(/,
      `${file} must derive layout from the live window, not a module-scope Dimensions.get capture`,
    );
  }
});

test('responsive screens route layout through the central responsive system', () => {
  for (const file of RESPONSIVE_SCREENS) {
    const src = read(file);
    assert.match(
      src,
      /useResponsiveLayout/,
      `${file} must consume useResponsiveLayout`,
    );
  }
});

test('no screen branches on a device model name', () => {
  const files = [
    ...RESPONSIVE_SCREENS,
    'app/auth/index.tsx',
    'app/style-chat/[sessionId].tsx',
    'components/luxury/LuxuryScreen.tsx',
    'hooks/useResponsiveLayout.ts',
    'services/responsiveLayout.js',
  ];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /isPad|iPad Pro|Platform\.isPad|isTablet/i, `${file} must not check a device model`);
  }
});

// ── No state reset or duplicate work on dimension change ────────────────────

test('layout width is never threaded into effect dependencies that fetch or reset state', () => {
  // A resize changes width/height. If those values appear in a data-loading
  // effect's dependency array, every rotation re-runs the request.
  const suspicious = /useEffect\([\s\S]{0,4000}?\}\s*,\s*\[[^\]]*\b(width|height|windowWidth|windowHeight|isLandscape|widthClass|gridColumns|contentWidth)\b[^\]]*\]\)/g;
  for (const file of [...RESPONSIVE_SCREENS, 'app/style-chat/[sessionId].tsx']) {
    const src = read(file);
    const matches = src.match(suspicious);
    assert.equal(
      matches,
      null,
      `${file} must not key an effect to window dimensions — that re-runs work on every rotation/resize`,
    );
  }
});

test('responsive values are derived during render, never stored in component state', () => {
  for (const file of RESPONSIVE_SCREENS) {
    const src = read(file);
    assert.doesNotMatch(
      src,
      /useState[^\n]*\b(gridColumns|widthClass|contentWidth|cardWidth|cellWidth)\b/i,
      `${file} must derive responsive values during render so a resize cannot desynchronize them`,
    );
  }
});

// ── Actor isolation must survive layout work ────────────────────────────────

test('an actor transition still tears down the previous actor detail view', () => {
  // Reflowing a grid on rotation re-renders the same screen that holds a
  // selected scan. If the actor-transition effect ever stops clearing that
  // selection, one account's scan stays on screen across a switch.
  const src = read('app/library.tsx');
  const effect = src.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[actorKey\]\);/);
  assert.ok(effect, 'app/library.tsx must keep an effect keyed to actorKey');
  const body = effect[1];
  for (const [statement, why] of [
    ['scanOpenSeqRef.current += 1', 'in-flight lineage lookups must be invalidated'],
    ['setSelectedScan(null)', 'the previous actor’s scan must be unmounted'],
    ['setDressingRoomModalVisible(false)', 'a modal over the previous actor’s scan must close'],
    ["setClosetState('idle')", 'a stale "In Your Closet" badge must not survive'],
  ]) {
    assert.ok(
      body.includes(statement),
      `actor transition must run ${statement} — ${why}`,
    );
  }
});

// ── Compact iPhone preservation ─────────────────────────────────────────────

test('the shared screen wrapper leaves compact widths uncapped', () => {
  const src = read('components/luxury/LuxuryScreen.tsx');
  assert.match(src, /maxContentWidth/, 'LuxuryScreen must expose a content-width cap');
  assert.match(
    src,
    /CONTENT_MAX_WIDTH/,
    'the cap must come from the central responsive module, not a local literal',
  );
  assert.match(
    src,
    /paddingHorizontal:\s*SPACING\.lg/,
    'compact horizontal padding must be unchanged from the certified iPhone build',
  );
});

test('bottom-sheet analysis surfaces cap their width without changing phone layout', () => {
  for (const file of ['components/AnalysisCard.tsx', 'components/scan-results/ScanResultV2.tsx']) {
    const src = read(file);
    assert.match(src, /maxWidth:\s*modalMaxWidth/, `${file} must cap sheet width on regular widths`);
    assert.match(src, /alignSelf:\s*'center'/, `${file} must center the capped sheet`);
    assert.match(
      src,
      /justifyContent:\s*'flex-end'/,
      `${file} must keep the certified bottom-sheet anchoring`,
    );
  }
});

// Every bottom sheet and dialog that spans the full width on a phone must be
// capped, or it becomes a 1024-1366pt-wide floating surface on iPad.
const CAPPED_MODAL_FILES = [
  'components/AddScanToDressingRoomModal.tsx',
  'components/AddInspirationToDressingRoomModal.tsx',
  'components/InspirationUploadModal.tsx',
  'components/dressing-rooms/RoomItemDetailModal.tsx',
  'components/looks/AskMyRoomModal.tsx',
  'components/style-chat/StyleChatAttachmentBar.tsx',
  'components/style-chat/StyleChatPhotoIntake.tsx',
  'components/style-chat/StyleChatStyleDnaCard.tsx',
  'components/style-chat/EliseVisualSourceMenu.tsx',
  'components/ProductShelf.tsx',
  'app/stylist/index.tsx',
  'app/dressing-rooms/[id].tsx',
  'app/dressing-rooms/index.tsx',
  'app/looks/[id].tsx',
  'app/privacy.tsx',
];

test('every full-width modal surface is capped from the central responsive module', () => {
  for (const file of CAPPED_MODAL_FILES) {
    const src = read(file);
    assert.match(
      src,
      /MODAL_MAX_WIDTH/,
      `${file} must cap its sheet/dialog width using the shared MODAL_MAX_WIDTH token`,
    );
    assert.match(
      src,
      /maxWidth:\s*MODAL_MAX_WIDTH/,
      `${file} must apply MODAL_MAX_WIDTH to a style, not merely import it`,
    );
    assert.doesNotMatch(
      src,
      /maxWidth:\s*560\b/,
      `${file} must not hardcode the cap value — it belongs to the central module`,
    );
  }
});

test('the Closet intake sheet keeps its native iOS pageSheet presentation', () => {
  const src = read('components/closet/ClosetIntakeModal.tsx');
  assert.match(
    src,
    /presentationStyle=\{Platform\.OS === 'ios' \? 'pageSheet' : undefined\}/,
    'Closet intake already uses a native sheet, which is iPad-correct without a manual cap',
  );
});

test('the legacy scanner preview and CTAs are capped on regular widths', () => {
  const src = read('app.js');
  assert.match(src, /MEDIA_MAX_WIDTH/, 'the captured-garment preview must be width-capped');
  assert.match(src, /maxWidth: MODAL_MAX_WIDTH/, 'scanner CTAs must stay a reachable width');
});

test('sheet entry animation derives from the live window height', () => {
  for (const file of ['components/AnalysisCard.tsx', 'components/scan-results/ScanResultV2.tsx']) {
    const src = read(file);
    assert.match(
      src,
      /const fromY = windowHeight \* 0\.36/,
      `${file} must animate from the current window height, not a stale launch-time constant`,
    );
  }
});

// ── Commerce and Closet boundaries are untouched by layout work ─────────────

// Comments in these modules legitimately discuss the boundaries they enforce,
// so assertions run against executable source only.
function readCode(relativePath) {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('Recent Scans still renders commerce and the Closet still excludes it', () => {
  const library = read('app/library.tsx');
  assert.match(library, /purchaseOptions=\{/, 'Recent Scans must still pass purchase options through');
  assert.match(library, /<AnalysisCard/, 'Recent Scans must retain the commerce-bearing analysis card');
  const closetCode = readCode('services/closetLibrary.js');
  assert.doesNotMatch(
    closetCode,
    /purchaseOptions|retailerName|productUrl|\bprice\b/i,
    'the Closet store must remain free of commerce fields',
  );
});

test('Closet media stays on its own root, so layout work cannot merge media lifecycles', () => {
  const closetCode = readCode('services/closetLibrary.js');
  assert.match(closetCode, /kscan_closet\//, 'Closet media must live under its own root');
  assert.doesNotMatch(
    closetCode,
    /kscan_library/,
    'the Closet store must not reach into the scan library media root',
  );
});
