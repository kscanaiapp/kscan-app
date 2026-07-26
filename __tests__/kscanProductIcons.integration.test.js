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

test('integration: Recent Scans chip uses recent-scans icon and keeps /library', () => {
  assert.match(HOME, /name="recent-scans"/);
  assert.match(HOME, /title="RECENT SCANS"/);
  assert.match(HOME, /testID="home-luxury-feature-recent-scans"/);
  assert.match(HOME, /accessibilityLabel="Recent Scans"/);
  assert.match(HOME, /onPress=\{\(\) => router\.push\('\/library'\)\}/);
});

test('integration: Visual Search uses visual-search icon and keeps /scan', () => {
  assert.match(HOME, /name="visual-search"/);
  assert.match(HOME, /title="VISUAL SEARCH"/);
  assert.match(HOME, /testID="home-luxury-feature-scan"/);
  assert.match(HOME, /onPress=\{\(\) => router\.push\('\/scan'\)\}/);
  assert.match(HOME, /accessibilityLabel="Open Visual Search"/);
});

test('integration: Closet uses save-organize icon and keeps /library', () => {
  assert.match(HOME, /name="save-organize"/);
  assert.match(HOME, /title="CLOSET"/);
  assert.match(HOME, /testID="home-luxury-feature-library"/);
  assert.match(HOME, /router\.push\('\/library'\)/);
  assert.match(HOME, /accessibilityLabel="Open Closet"/);
});

test('integration: Dressing Rooms uses dressing-rooms icon and keeps route', () => {
  assert.match(HOME, /name="dressing-rooms"/);
  assert.match(HOME, /title="DRESSING ROOMS"/);
  assert.match(HOME, /testID="home-luxury-feature-dressing-rooms"/);
  assert.match(HOME, /router\.push\('\/dressing-rooms'\)/);
  assert.match(HOME, /accessibilityLabel="Open Dressing Rooms"/);
});

test('integration: TextScan uses compact icon and preserves live navigation behavior', () => {
  assert.match(HOME, /name="textscan"/);
  assert.match(HOME, /size=\{20\}/);
  assert.match(HOME, /variant="compact"/);
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

test('integration: Start Scan CTA and VoiceScan remain unchanged', () => {
  assert.match(HOME, /testID="home-luxury-start-scan"/);
  assert.match(HOME, /title="✧ START SCAN"/);
  assert.match(HOME, /testID="home-luxury-voicescan-coming-soon"/);
  assert.match(HOME, /VOICE SCAN/);
  assert.match(HOME, /COMING SOON/);
  assert.match(HOME, /VOICESCAN_ENABLED/);
});

test('integration: SecondaryButton still supports icon slot used by TextScan', () => {
  assert.match(LUXURY_BUTTON, /icon\?: React\.ReactNode/);
  assert.match(HOME, /icon=\{<KScanIcon name="textscan"/);
});

test('integration: chip dimensions stay icon-bounded at 28px', () => {
  assert.match(HOME, /size=\{28\}/);
  assert.match(HOME, /chipIconWrap:\s*\{[\s\S]*width:\s*28/);
  assert.match(HOME, /height:\s*28/);
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
