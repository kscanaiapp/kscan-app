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
const androidManifest = fs.readFileSync(
  path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  'utf8',
);

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
  assert.doesNotMatch(homeV1, /title="AI STYLIST"/);
  assert.match(homeV1, /title="RECENT SCANS"/);
  assert.match(homeV1, /home-luxury-feature-recent-scans/);
});

test('full Recent Scans carousel is absent from Home', () => {
  assert.doesNotMatch(homeV1, /<SavedLookCard/);
  assert.doesNotMatch(homeV1, /home-luxury-recent-scan-/);
  assert.doesNotMatch(homeV1, /home-luxury-view-all-scans/);
});

test('Style Picks is not fabricated when absent, and renders nothing rather than an empty placeholder', () => {
  assert.match(homeV1, /STYLE PICKS FOR YOU/);
  assert.match(homeV1, /showStylePicks && \(/);
  assert.match(homeV1, /stylePicksLoading \|\| Boolean\(stylePicksError\) \|\| hasStylePicks/);
  assert.doesNotMatch(homeV1, /Style inspiration coming soon/);
});

// ── Latest Scan / Recent Scans tile wiring ───────────────────────────────────

test('Recent Scans tile routes to library without a Home-only library query', () => {
  assert.doesNotMatch(homeV1, /useLibrary\(\)/);
  assert.doesNotMatch(homeV1, /const latestScan = scans\[0\] \?\? null/);
  assert.doesNotMatch(homeV1, /recentScansTileImage/);
  assert.match(homeV1, /body="Open your scan history\."/);
  // The destination is the explicit Recent Scan section. Bare '/library'
  // resolves to whatever the route defaults to, which is how the Closet chip
  // used to open scan history. The behavioural proof of the emitted payload
  // lives in closetRecentScanNavigationSeparation.test.js.
  assert.match(
    homeV1,
    /router\.push\(\{ pathname: '\/library', params: \{ section: 'recent' \} \}\)/,
  );
  assert.doesNotMatch(homeV1, /router\.push\('\/library'\)/);
});

// ── Four-box feature grid ────────────────────────────────────────────────────

test('four-box feature grid remains with the required boxes', () => {
  assert.match(homeV1, /title="RECENT SCANS"/);
  assert.match(homeV1, /title="VISUAL SEARCH"/);
  assert.match(homeV1, /title="CLOSET"/);
  assert.match(homeV1, /title="DRESSING ROOMS"/);
});

test('Recent Scans and Closet boxes route to distinct library sections', () => {
  const recentBox = homeV1.indexOf('testID="home-luxury-feature-recent-scans"');
  const closetBox = homeV1.indexOf('testID="home-luxury-feature-library"');
  assert.ok(recentBox > 0, 'Recent Scans chip must exist');
  assert.ok(closetBox > 0, 'Closet chip must exist');

  const recentRoute = "router.push({ pathname: '/library', params: { section: 'recent' } })";
  const closetRoute = "router.push({ pathname: '/library', params: { section: 'closet' } })";

  // Each chip's own handler carries its own section — neither inherits the
  // other's destination and neither falls back to the route default.
  assert.ok(homeV1.includes(recentRoute), 'Recent Scans must open section=recent');
  assert.ok(homeV1.includes(closetRoute), 'Closet must open section=closet');
  assert.notEqual(recentRoute, closetRoute);
});

test('no saved-scan card list renders on Home', () => {
  assert.doesNotMatch(homeV1, /recentScans\.map\(/);
  assert.doesNotMatch(homeV1, /home-luxury-recent-scan-/);
});

// ── TextScan / Voice Scan footer pills ───────────────────────────────────────

test('TextScan pill is rendered and routes to the text-scan screen', () => {
  assert.match(homeV1, /testID="home-luxury-textscan"/);
  assert.match(homeV1, /title="TEXTSCAN"/);
  assert.match(homeV1, /router\.push\('\/text-scan'\)/);
  assert.match(homeV1, /handleOpenTextScan/);
  assert.match(homeV1, /textScanNavigating/);
});

test('TextScan navigation guard prevents rapid duplicates and releases on focus', () => {
  assert.match(homeV1, /useRef\(false\)/);
  assert.match(homeV1, /textScanNavigationInFlightRef\.current/);
  assert.match(homeV1, /if \(textScanNavigationInFlightRef\.current\) return/);
  assert.match(homeV1, /textScanNavigationInFlightRef\.current = true/);
  assert.match(homeV1, /useFocusEffect\(/);
  assert.match(homeV1, /textScanNavigationInFlightRef\.current = false/);
  assert.doesNotMatch(homeV1, /setTimeout\(\(\) => setTextScanNavigating\(false\)/);
});

test('Build 33: the unfinished Voice Scan surface is absent from production Home', () => {
  // Build 32 shipped a reviewer-visible "VOICE SCAN / COMING SOON" pill. Voice
  // Scan is unimplemented, so App Review could read Home as an incomplete app.
  // Build 33 removes the surface outright rather than dimming it.
  assert.doesNotMatch(homeV1, /voicescan/i);
  assert.doesNotMatch(homeV1, /VOICE SCAN/);
  assert.doesNotMatch(homeV1, /COMING SOON/);
  assert.doesNotMatch(homeV1, /VOICESCAN_ENABLED/);
  // TextScan is a real, shipping entry point and must survive the removal.
  assert.match(homeV1, /testID="home-luxury-textscan"/);
});

test('Android manifest removes mic, fine-location, and storage permissions from dependency merges', () => {
  for (const permission of [
    'android.permission.RECORD_AUDIO',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]) {
    const pattern = new RegExp(`<uses-permission android:name="${permission}" tools:node="remove"\\/>`);
    assert.match(androidManifest, pattern);
  }
});

test('TextScan UI flag defaults to enabled', () => {
  assert.match(featureFlags, /EXPO_PUBLIC_ENABLE_TEXTSCAN !== 'false'/);
  assert.doesNotMatch(featureFlags, /EXPO_PUBLIC_ENABLE_TEXTSCAN === 'true'/);
  const flagFor = (value) => value !== 'false';
  assert.equal(flagFor(undefined), true);
  assert.equal(flagFor('true'), true);
  assert.equal(flagFor('false'), false);
});

// ── Navigation primitives ────────────────────────────────────────────────────

test('Ask Elise CTA routes to existing StyleChat session list', () => {
  assert.match(homeV1, /router\.push\('\/style-chat'\)/);
  assert.match(homeStylistCard, /onOpenConversations/);
  assert.match(homeStylistCard, /onStartConversation/);
});

test('Home route parameters are stable primitives', () => {
  // Object-form push is REQUIRED for the library sections, but every param it
  // carries must still be a static string literal. Nothing on Home may build a
  // destination out of interpolated or runtime-derived state.
  const objectPushes = homeV1.match(/router\.push\(\{[^}]*params:\s*\{[^}]*\}\s*\}\)/g) || [];
  assert.ok(objectPushes.length > 0, 'Home uses object-form push for library sections');
  for (const push of objectPushes) {
    assert.match(
      push,
      /^router\.push\(\{ pathname: '\/library', params: \{ section: '(recent|closet)' \} \}\)$/,
      `unexpected object-form route on Home: ${push}`,
    );
    assert.doesNotMatch(push, /\$\{/, 'route params must not be interpolated');
  }
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

test('Home sessions hook resumes the latest conversation without conditional resume copy', () => {
  assert.match(useStyleChatSessions, /listStyleChatSessions/);
  assert.match(homeV1, /const \{ createSession, getLatestSessionId \} = useStyleChatSessions\(\)/);
  assert.match(homeV1, /launchStyleChatSession/);
  // Which conversation to resume is resolved server-side inside the launch
  // guard. Deriving it from the locally loaded list raced with that list's
  // load: before it arrived the card read "no sessions", flipped its copy, and
  // started a new conversation on top of an existing one.
  assert.doesNotMatch(homeV1, /hasStyleChatSessions/);
  assert.doesNotMatch(homeV1, /sessions\.length/);
  assert.doesNotMatch(homeStylistCard, /hasSessions/);
});

// ── Canonical stylist card: the three required user actions ─────────────────
//
// "Start Chat" and "Personalize" are already asserted in stylistIdentity.test.js.
// The header action was not asserted anywhere, so the card could have lost its
// route into the existing conversation list without a single test noticing.

test('the stylist card keeps all three user actions, including Chat with <name>', () => {
  assert.match(homeStylistCard, /Chat with \{displayName\}/);
  assert.match(homeStylistCard, /accessibilityLabel=\{`Chat with \$\{displayName\}`\}/);
  assert.match(homeStylistCard, /onPersonalize/);
  assert.match(homeStylistCard, /Personalize/);
  assert.match(homeStylistCard, /title="Start Chat"/);
  // The name shown is the personalized identity with the shipped default as a
  // fallback -- never a hardcoded stylist name.
  assert.match(
    homeStylistCard,
    /identity\.displayName \|\| DEFAULT_STYLIST_IDENTITY\.displayName/,
  );
});

// ── The stale generic Home surface stays unreachable ────────────────────────
//
// This is the regression that was actually reported: a generic
// "YOUR AI STYLIST / Ask StyleChat" card with an initial-letter avatar in
// place of the canonical stylist card and its animated portrait. The canonical
// implementation is present and correct, so this guard exists to keep it that
// way -- the runtime Home chain must never reference the stale surface again.
//
// Scanned as CODE, not as text. The Home files legitimately explain what they
// deliberately do NOT render, and a naive search would report that discipline
// as a violation of itself. House convention (vtoLiveIntegrationScope,
// notificationsClosureConvergence) is to strip comments first.

test('no runtime Home surface references the stale generic stylist card', () => {
  const stripComments = (source) =>
    source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // The complete runtime Home chain: the route, the barrel it imports through,
  // the Home composition, and the stylist card itself.
  const chain = {
    'app/index.tsx': path.join(ROOT, 'app', 'index.tsx'),
    'components/home/index.ts': path.join(ROOT, 'components', 'home', 'index.ts'),
    'components/home/HomeLuxuryTechV1.tsx': path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'),
    'components/home/HomeStylistCard.tsx': path.join(ROOT, 'components', 'home', 'HomeStylistCard.tsx'),
  };

  const FORBIDDEN = [
    /StylistGreetingCard/,
    /YOUR AI STYLIST/i,
    /Ask StyleChat/i,
    /avatars\/AnimatedAvatar/,
  ];

  for (const [label, file] of Object.entries(chain)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(code, pattern, `${label} must not reference the stale generic Home surface`);
    }
  }

  // The route mounts the canonical Home directly, with no legacy fallback.
  const route = stripComments(fs.readFileSync(chain['app/index.tsx'], 'utf8'));
  assert.match(route, /<HomeLuxuryTechV1 \/>/);
  assert.doesNotMatch(route, /HomeLegacy|HomeV2/);

  // And the canonical card renders the animated portrait rather than an
  // initial-letter placeholder, which is what the regression showed.
  assert.match(homeStylistCard, /<AnimatedStylistAvatar/);
  assert.match(homeStylistCard, /avatarId=\{identity\.avatarId\}/);

  // The detector is proven to detect. A comment-stripper that ate too much
  // would pass over a real reintroduction and report nothing, which is
  // indistinguishable from success.
  assert.match(stripComments('const x = <StylistGreetingCard />;'), /StylistGreetingCard/);
  assert.doesNotMatch(
    stripComments('// StylistGreetingCard is deliberately not used here'),
    /StylistGreetingCard/,
  );
});
