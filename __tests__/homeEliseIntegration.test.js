// Home Elise integration: layout hierarchy, feature flags, and navigation contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const homeV1 = fs.readFileSync(path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'), 'utf8');
const featureFlags = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');
const homeStylistCard = fs.readFileSync(path.join(ROOT, 'components', 'home', 'HomeStylistCard.tsx'), 'utf8');
const stylistIdentityConstants = fs.readFileSync(path.join(ROOT, 'constants', 'stylistIdentity.ts'), 'utf8');
const useStylistIdentity = fs.readFileSync(path.join(ROOT, 'hooks', 'useStylistIdentity.ts'), 'utf8');
const useStyleChatSessions = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChatSessions.ts'), 'utf8');

// ── Layout hierarchy ─────────────────────────────────────────────────────────

test('Ask Elise / Your Stylist section remains', () => {
  assert.match(homeV1, /<HomeStylistCard/);
  assert.match(homeV1, /styleChatEnabled/);
  assert.match(homeV1, /handleStartConversation/);
  assert.match(homeV1, /handleOpenStyleChat/);
});

test('Scan hero remains first and visually dominant', () => {
  const heroIndex = homeV1.indexOf('<View style={styles.heroCard}>');
  const stylistIndex = homeV1.indexOf('<HomeStylistCard');
  assert.ok(heroIndex > 0);
  assert.ok(stylistIndex > heroIndex);
  assert.match(homeV1, /heroCard/);
  assert.match(homeV1, /heroImageActual/);
  assert.match(homeV1, /START SCAN/);
});

test('stylist card appears before the feature grid and no carousel follows it', () => {
  const stylistIndex = homeV1.indexOf('<HomeStylistCard');
  const featureGridIndex = homeV1.indexOf('featuresRow');

  assert.ok(stylistIndex > 0);
  assert.ok(featureGridIndex > stylistIndex);
  assert.doesNotMatch(homeV1, /<SavedLookCard/);
});

test('AI Stylist tile is removed and replaced with Recent Scans tile', () => {
  assert.doesNotMatch(homeV1, /title="ASK ELISE"/);
  assert.doesNotMatch(homeV1, /AI STYLIST/);
  assert.match(homeV1, /title="RECENT SCANS"/);
  assert.match(homeV1, /home-luxury-feature-recent-scans/);
});

test('full Recent Scans carousel is absent from Home', () => {
  assert.doesNotMatch(homeV1, /<SavedLookCard/);
  assert.doesNotMatch(homeV1, /home-luxury-recent-scan-/);
  assert.doesNotMatch(homeV1, /home-luxury-view-all-scans/);
});

test('Style Picks is not fabricated when absent', () => {
  assert.match(homeV1, /STYLE PICKS FOR YOU/);
  assert.match(homeV1, /stylePicksStatus/);
  assert.match(homeV1, /backend_not_connected/);
});

// ── Latest Scan / Recent Scans tile wiring ───────────────────────────────────

test('Recent Scans tile resolves newest owned scan from useLibrary', () => {
  assert.match(homeV1, /const latestScan = scans\[0\] \?\? null/);
  assert.match(homeV1, /recentScansTileImage/);
  assert.match(homeV1, /onPress=\{\(\) => router\.push\('\/library'\)\}/);
});

test('Recent Scans tile shows honest empty state when no scans exist', () => {
  assert.match(homeV1, /No recent scans yet/);
});

// ── Four-box feature grid ────────────────────────────────────────────────────

test('four-box feature grid remains with the required boxes', () => {
  assert.match(homeV1, /title="RECENT SCANS"/);
  assert.match(homeV1, /title="VISUAL SEARCH"/);
  assert.match(homeV1, /title="SAVE & ORGANIZE"/);
  assert.match(homeV1, /title="DRESSING ROOMS"/);
});

test('Recent Scans box routes to the existing library/history experience', () => {
  const recentScansBox = homeV1.indexOf('testID="home-luxury-feature-recent-scans"');
  const libraryRoute = homeV1.indexOf("router.push('/library')", recentScansBox);
  assert.ok(recentScansBox > 0);
  assert.ok(libraryRoute > recentScansBox);
});

test('no saved-scan card list renders on Home', () => {
  assert.doesNotMatch(homeV1, /recentScans\.map\(/);
  assert.doesNotMatch(homeV1, /home-luxury-recent-scan-/);
});

// ── Navigation primitives ────────────────────────────────────────────────────

test('Ask Elise CTA routes to existing StyleChat session list', () => {
  assert.match(homeV1, /router\.push\('\/style-chat'\)/);
  assert.match(homeStylistCard, /onOpenConversations/);
  assert.match(homeStylistCard, /onStartConversation/);
});

test('Home route parameters are stable primitives', () => {
  assert.doesNotMatch(homeV1, /router\.push\(\{\s*pathname:.*?params:\s*\{/s);
  assert.doesNotMatch(homeV1, /router\.push\('\/style-chat\/\$\{identity/);
  assert.doesNotMatch(homeV1, /router\.push\('\/style-chat',\s*\{/);
});

// ── Feature flags ────────────────────────────────────────────────────────────

test('Ask Elise remains visible when only structured AI Stylist is disabled', () => {
  assert.match(homeV1, /styleChatEnabled/);
  assert.match(homeV1, /isFeatureEnabled\('styleChat'\)/);
  assert.doesNotMatch(homeV1, /AI_STYLIST_UI_ENABLED[^\n]*styleChatEnabled/);
});

test('AI Stylist capability gate does not hide conversational Elise', () => {
  assert.doesNotMatch(homeStylistCard, /AI_STYLIST_UI_ENABLED/);
  assert.doesNotMatch(homeStylistCard, /STYLECHAT_ATTACHMENTS_ENABLED/);
});

test('feature flag source supports styleChat and aiStylist keys', () => {
  assert.match(featureFlags, /'styleChat'/);
  assert.match(featureFlags, /'aiStylist'/);
  assert.match(featureFlags, /AI_STYLIST_UI_ENABLED/);
});

// ── Identity integration ─────────────────────────────────────────────────────

test('Home uses one stable stylist identity source', () => {
  assert.match(homeV1, /const \{ identity/);
  assert.match(homeV1, /useStylistIdentity\(\)/);
  assert.equal(
    (homeV1.match(/useStylistIdentity\(\)/g) || []).length,
    1,
    'Home should call useStylistIdentity once',
  );
});

test('identity hook hydrates once per authenticated actor', () => {
  assert.match(useStylistIdentity, /previousUserIdRef\.current === userId/);
  assert.match(useStylistIdentity, /void hydrateStylistIdentityForUser\(userId\)/);
  assert.match(useStylistIdentity, /resetStylistIdentityStore\(\)/);
});

test('sessions hook provides continue/start conversation state', () => {
  assert.match(useStyleChatSessions, /listStyleChatSessions/);
  assert.match(homeV1, /const \{ sessions: styleChatSessions/);
  assert.match(homeV1, /hasStyleChatSessions = styleChatSessions\.length > 0/);
});
