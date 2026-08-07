const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HOME = fs.readFileSync(
  path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'),
  'utf8',
);
const STYLIST_CARD = fs.readFileSync(
  path.join(ROOT, 'components', 'home', 'HomeStylistCard.tsx'),
  'utf8',
);
const SCAN_LANDING = fs.readFileSync(
  path.join(ROOT, 'components', 'scan-room', 'ScanLanding.tsx'),
  'utf8',
);
const LIVE_SCAN_CAMERA = fs.readFileSync(
  path.join(ROOT, 'components', 'scan-room', 'LiveScanCamera.tsx'),
  'utf8',
);
const SCAN_ROOM_HEADER = fs.readFileSync(
  path.join(ROOT, 'components', 'scan-room', 'ScanRoomHeader.tsx'),
  'utf8',
);
const LIVE_HOME = fs.readFileSync(path.join(ROOT, 'app', 'index.tsx'), 'utf8');
const REVIEW = fs.readFileSync(path.join(ROOT, 'app', 'dev', 'icon-review.tsx'), 'utf8');
const LUXURY_BUTTON = fs.readFileSync(
  path.join(ROOT, 'components', 'luxury', 'LuxuryButton.tsx'),
  'utf8',
);

test('integration: live router home renders HomeLuxuryTechV1', () => {
  assert.match(LIVE_HOME, /import \{ HomeLuxuryTechV1 \} from '\.\.\/components\/home'/);
  assert.match(LIVE_HOME, /return <HomeLuxuryTechV1 \/>/);
});

// Cross-platform parity contract. The YOUR STYLIST section header is a
// DECORATIVE sparkle on both iOS and Android; it is deliberately not a
// product icon. iOS enforces the same contract in kscanProductIcons.test.js
// ('preserve: YOUR STYLIST section-header sparkle is untouched'). Keep these
// two assertions semantically equivalent - diverging them silently breaks the
// other platform's accepted suite.
test('integration: YOUR STYLIST header keeps the decorative sparkle (cross-platform parity)', () => {
  assert.match(STYLIST_CARD, /<Text style=\{styles\.sparkle\}>✦<\/Text>/);
  assert.match(STYLIST_CARD, /YOUR STYLIST/);
  assert.doesNotMatch(STYLIST_CARD, /KScanIcon/);
});

test('integration: Recent Scans chip uses recent-scans icon and opens the recent section', () => {
  assert.match(HOME, /name="recent-scans"/);
  assert.match(HOME, /title="RECENT SCANS"/);
  assert.match(HOME, /testID="home-luxury-feature-recent-scans"/);
  assert.match(HOME, /accessibilityLabel="Recent Scans"/);
  assert.match(
    HOME,
    /router\.push\(\{ pathname: '\/library', params: \{ section: 'recent' \} \}\)/,
  );
});

test('integration: Visual Search uses visual-search icon and keeps /scan', () => {
  assert.match(HOME, /name="visual-search"/);
  assert.match(HOME, /title="VISUAL SEARCH"/);
  assert.match(HOME, /testID="home-luxury-feature-scan"/);
  assert.match(HOME, /onPress=\{\(\) => router\.push\('\/scan'\)\}/);
  assert.match(HOME, /accessibilityLabel="Open Visual Search"/);
});

test('integration: Closet uses save-organize icon and opens the closet section', () => {
  assert.match(HOME, /name="save-organize"/);
  assert.match(HOME, /title="CLOSET"/);
  assert.match(HOME, /testID="home-luxury-feature-library"/);
  assert.match(
    HOME,
    /router\.push\(\{ pathname: '\/library', params: \{ section: 'closet' \} \}\)/,
  );
  assert.match(HOME, /accessibilityLabel="Open Closet"/);
});

test('integration: Dressing Rooms uses dressing-rooms icon and keeps route', () => {
  assert.match(HOME, /name="dressing-rooms"/);
  assert.match(HOME, /title="DRESSING ROOMS"/);
  assert.match(HOME, /testID="home-luxury-feature-dressing-rooms"/);
  assert.match(HOME, /router\.push\('\/dressing-rooms'\)/);
  assert.match(HOME, /accessibilityLabel="Open Dressing Rooms"/);
});

test('integration: TextScan uses the shared icon size and preserves live navigation behavior', () => {
  assert.match(HOME, /name="textscan"/);
  // Previously 20pt/compact. TextScan now renders at the same 24pt as the four
  // grid icons: at 20pt a 24-unit glyph scaled by 0.833, which both softened
  // every edge and rendered its stroke ~30% lighter than its siblings.
  assert.match(HOME, /name="textscan" size=\{24\}/);
  assert.match(HOME, /title="TEXTSCAN"/);
  assert.match(HOME, /testID="home-luxury-textscan"/);
  assert.match(HOME, /handleOpenTextScan/);
  assert.match(HOME, /TEXTSCAN_UI_ENABLED/);
  assert.match(HOME, /isFeatureEnabled\('textScan'\)/);
  assert.doesNotMatch(HOME, /secondaryPillIcon|>✧</);
});

test('integration: feature chip icons are decorative under labeled buttons', () => {
  assert.match(HOME, /accessibilityElementsHidden/);
  assert.match(HOME, /importantForAccessibility="no"/);
  assert.match(HOME, /chipIconWrap/);
});

// BUG-10 (Build 25 Phase 4). The three PRODUCT call-to-action surfaces below
// shipped a Unicode sparkle glyph on Android while iOS already rendered the
// approved KScanIcon family. A text glyph is not a product icon: it inherits the
// font, has no variant/colour contract, and cannot be kept in visual step with
// the icon set. These assertions encode the repaired contract — an explicit
// KScanIcon plus a PLAIN label — and the doesNotMatch guards are what fail if
// the sparkle is ever reintroduced.
test('integration: BUG-10 Start Scan CTA uses visual-search KScanIcon and a plain label', () => {
  assert.match(HOME, /testID="home-luxury-start-scan"/);
  assert.match(HOME, /title="START SCAN"/);
  assert.match(HOME, /icon=\{\s*<KScanIcon\s+name="visual-search"/);
  assert.doesNotMatch(HOME, /title="✧ START SCAN"/);
  assert.doesNotMatch(HOME, /✧ START SCAN/);
});

test('integration: VoiceScan Coming Soon remains unchanged', () => {
  assert.match(HOME, /testID="home-luxury-voicescan-coming-soon"/);
  assert.match(HOME, /VOICE SCAN/);
  assert.match(HOME, /COMING SOON/);
  assert.match(HOME, /VOICESCAN_ENABLED/);
});

test('integration: BUG-10 ScanLanding TextScan CTA uses textscan KScanIcon and a plain label', () => {
  assert.match(SCAN_LANDING, /import \{ KScanIcon \} from '\.\.\/icons\/kscan'/);
  assert.match(SCAN_LANDING, /<KScanIcon name="textscan" size=\{16\} variant="compact" \/>/);
  assert.match(SCAN_LANDING, /<Text style=\{styles\.textScanText\}>Describe an item<\/Text>/);
  assert.match(SCAN_LANDING, /testID="scan-room-textscan"/);
  assert.doesNotMatch(SCAN_LANDING, /✧ Describe an item/);
  assert.doesNotMatch(SCAN_LANDING, /✧/);
});

test('integration: BUG-10 LiveScanCamera TextScan control uses textscan KScanIcon and a plain label', () => {
  assert.match(LIVE_SCAN_CAMERA, /import \{ KScanIcon \} from '\.\.\/icons\/kscan'/);
  assert.match(LIVE_SCAN_CAMERA, /<KScanIcon name="textscan" size=\{14\} variant="compact" \/>/);
  assert.match(LIVE_SCAN_CAMERA, /<Text style=\{styles\.controlPillText\}>TextScan<\/Text>/);
  assert.doesNotMatch(LIVE_SCAN_CAMERA, /✧ TextScan/);
  assert.doesNotMatch(LIVE_SCAN_CAMERA, /✧/);
});

// The repair must not have swept up decoration. ScanResultV2 and ScanRoomHeader
// use ✧ as a divider ornament — no label, no press target, identical on iOS —
// and Phase 4 explicitly leaves intentional decoration alone.
test('integration: BUG-10 did not strip decorative dividers', () => {
  assert.match(SCAN_ROOM_HEADER, /<Text style=\{styles\.dividerText\}>✧<\/Text>/);
});

test('integration: SecondaryButton still supports icon slot used by TextScan', () => {
  assert.match(LUXURY_BUTTON, /icon\?: React\.ReactNode/);
  assert.match(HOME, /icon=\{<KScanIcon name="textscan"/);
});

test('integration: chip container stays 28px and every icon renders 1:1 at 24', () => {
  // The tile and its icon container are unchanged; only the glyph inside them
  // moved. A 24-unit viewBox drawn at 24pt maps one user unit to a whole number
  // of device pixels at every integer density, so stroke edges land on pixel
  // boundaries instead of being antialiased across two rows. 28 did not: it
  // scaled by 7/6 and softened every edge in the set.
  assert.match(HOME, /chipIconWrap:\s*\{[\s\S]*width:\s*28/);
  assert.match(HOME, /height:\s*28/);
  assert.doesNotMatch(HOME, /<KScanIcon[^>]*size=\{28\}/);

  // Seven since the BUG-10 repair: the four grid tiles, TextScan, the Voice
  // Scan microphone (that pill previously carried no glyph at all and was the
  // only entry on Home identified by text alone), and the hero START SCAN CTA.
  //
  // The CTA is deliberately NOT in the 24pt 1:1 cohort. It is an inline button
  // icon sized to sit beside a 13pt label inside LuxuryButton, not a chip glyph
  // in a 28px container, and iOS has rendered it at 20 since Batch 5 — matching
  // that is the whole point of the repair. Holding it to 24 here would force
  // Android to diverge from the platform it is being aligned to.
  const iconSizes = [...HOME.matchAll(/<KScanIcon[^>]*size=\{(\d+)\}/g)].map((m) => m[1]);
  assert.equal(iconSizes.length, 7, 'expected every Home product icon');

  const ctaSizes = [
    ...HOME.matchAll(/<KScanIcon\s+name="visual-search"\s+size=\{(\d+)\}[\s\S]{0,200}?accentColor=/g),
  ].map((m) => m[1]);
  assert.deepEqual(ctaSizes, ['20'], 'the hero CTA icon matches the iOS 20pt inline treatment');

  const chipSizes = iconSizes.filter((_, index) => index !== iconSizes.indexOf('20'));
  assert.equal(chipSizes.length, 6, 'the six chip/grid icons remain');
  for (const size of chipSizes) {
    assert.equal(size, '24', 'every Home chip icon must render at the 1:1 size');
  }
});

test('integration: icon review screen is QA/dev gated and covers sizes/variants', () => {
  assert.match(REVIEW, /QA_TOOLS_ENABLED/);
  assert.match(REVIEW, /const SIZES = \[20, 24, 28, 32, 48\]/);
  assert.match(REVIEW, /'compact'/);
  assert.match(REVIEW, /'standard'/);
  assert.match(REVIEW, /pressed/);
  assert.match(REVIEW, /disabled/);
  assert.match(REVIEW, /plum-inverted/);
});

test('integration: home does not import raster product-icon references', () => {
  assert.doesNotMatch(HOME, /01-dressing-rooms-reference|02-textscan-reference|icon-qa\/references/);
  assert.doesNotMatch(HOME, /require\(['"`].*icon.*\.(png|jpe?g|webp)['"`]\)/i);
  assert.match(HOME, /from '\.\.\/icons\/kscan'/);
  assert.match(HOME, /home-hero-v1\.png/);
});

test('integration: no temporary product-action symbols remain on feature chips', () => {
  assert.doesNotMatch(HOME, /icon="✦"|icon="◈"|icon="◇"|icon="◉"/);
});
