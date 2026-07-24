const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HOME = fs.readFileSync(
  path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'),
  'utf8',
);
const LIVE_HOME = fs.readFileSync(path.join(ROOT, 'app', 'index.tsx'), 'utf8');
const REVIEW = fs.readFileSync(path.join(ROOT, 'app', 'dev', 'icon-review.tsx'), 'utf8');
const LUXURY_BUTTON = fs.readFileSync(
  path.join(ROOT, 'components', 'luxury', 'LuxuryButton.tsx'),
  'utf8',
);

test('integration: AI STYLIST uses Style icon and keeps StyleChat route', () => {
  assert.match(HOME, /name="style"/);
  assert.match(HOME, /title="AI STYLIST"/);
  assert.match(HOME, /router\.push\('\/style-chat'\)/);
  assert.match(HOME, /testID="home-luxury-feature-stylechat"/);
  assert.match(HOME, /accessibilityLabel="Open AI Stylist"/);
  assert.doesNotMatch(HOME, /FeatureChip[\s\S]*icon="✦"/);
});

test('integration: Visual Search uses visual-search icon and keeps /scan', () => {
  assert.match(HOME, /name="visual-search"/);
  assert.match(HOME, /title="VISUAL SEARCH"/);
  assert.match(HOME, /testID="home-luxury-feature-scan"/);
  assert.match(HOME, /onPress=\{\(\) => router\.push\('\/scan'\)\}/);
  assert.match(HOME, /accessibilityLabel="Open Visual Search"/);
});

test('integration: Save & Organize uses save-organize icon and keeps /library', () => {
  assert.match(HOME, /name="save-organize"/);
  assert.match(HOME, /title="SAVE & ORGANIZE"/);
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

test('integration: TextScan uses compact icon, label, flag, and /text-scan', () => {
  assert.match(HOME, /name="textscan"/);
  assert.match(HOME, /size=\{20\}/);
  assert.match(HOME, /variant="compact"/);
  assert.match(HOME, /title="TextScan"/);
  assert.match(HOME, /testID="home-luxury-textscan"/);
  assert.match(HOME, /router\.push\('\/text-scan'\)/);
  assert.match(HOME, /TEXTSCAN_UI_ENABLED/);
  assert.match(HOME, /isFeatureEnabled\('textScan'\)/);
  assert.doesNotMatch(HOME, /title="✧ TextScan"/);
});

test('integration: Recent Scans icon is decorative section identifier only', () => {
  assert.match(HOME, /name="recent-scans"/);
  assert.match(HOME, /title="RECENT SCANS"/);
  assert.match(HOME, /accessibilityElementsHidden/);
  assert.match(HOME, /importantForAccessibility="no"/);
  // No new Recent Scans press handler invented for the heading icon.
  assert.doesNotMatch(
    HOME,
    /recentScansIcon[\s\S]{0,120}onPress/,
  );
});

test('integration: View all and feature press handlers remain intact', () => {
  assert.match(HOME, /testID="home-luxury-view-all-scans"/);
  assert.match(HOME, /onPress=\{\(\) => router\.push\('\/library'\)\}/);
  assert.match(HOME, /testID="home-luxury-start-scan"/);
});

test('integration: VoiceScan placeholder remains unchanged', () => {
  assert.match(HOME, /testID="home-luxury-voicescan-coming-soon"/);
  assert.match(HOME, /VOICE SCAN/);
  assert.match(HOME, /COMING SOON/);
  assert.match(HOME, /VOICESCAN_ENABLED/);
});

test('integration: decorative sparkles outside product actions remain', () => {
  assert.match(HOME, /title="✧ START SCAN"/);
  assert.match(HOME, /profileName \? profileName\.charAt\(0\)\.toUpperCase\(\) : '✦'/);
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
  // Existing hero raster remains; product icons must stay vector components.
  assert.match(HOME, /from '\.\.\/icons\/kscan'/);
  assert.match(HOME, /home-hero-v1\.png/);
});

test('integration: live router home preserves destinations while using vector icons', () => {
  assert.match(LIVE_HOME, /from '\.\.\/components\/icons\/kscan'/);
  assert.match(LIVE_HOME, /name="visual-search"/);
  assert.match(LIVE_HOME, /testID="start-scan-button"/);
  assert.match(LIVE_HOME, /router\.push\('\/scan'\)/);
  assert.match(LIVE_HOME, /name="dressing-rooms"/);
  assert.match(LIVE_HOME, /router\.push\('\/dressing-rooms'\)/);
  assert.match(LIVE_HOME, /name="save-organize"/);
  assert.match(LIVE_HOME, /router\.push\('\/library'\)/);
  assert.match(LIVE_HOME, /name="style"/);
  assert.match(LIVE_HOME, /router\.push\('\/style-chat'\)/);
  assert.match(LIVE_HOME, /testID="home-voicescan-coming-soon"/);
  assert.doesNotMatch(LIVE_HOME, /styleChatDot/);
});
