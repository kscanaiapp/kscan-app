// Static source-contract checks for the K+ product surfaces: the Voice Scan
// pill conversion (Coming Soon -> Upgrade to K+ / Included with K+) and the
// Account/Profile K+ status row. Same style as homeEliseIntegration.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const textScanFeatureRow = fs.readFileSync(
  path.join(ROOT, 'components', 'text-scan', 'TextScanFeatureRow.tsx'),
  'utf8',
);
const privacyScreen = fs.readFileSync(path.join(ROOT, 'app', 'privacy.tsx'), 'utf8');
const kPlusGate = fs.readFileSync(path.join(ROOT, 'components', 'kplus', 'KPlusGate.tsx'), 'utf8');
const kPlusSheet = fs.readFileSync(
  path.join(ROOT, 'components', 'kplus', 'KPlusEarlyAccessSheet.tsx'),
  'utf8',
);
const authSessionContext = fs.readFileSync(
  path.join(ROOT, 'contexts', 'AuthSessionContext.tsx'),
  'utf8',
);

test('Voice Scan pill shows the K+ acquisition copy, gated by KPLUS_EARLY_ACCESS_ENABLED', () => {
  assert.match(textScanFeatureRow, /KPLUS_EARLY_ACCESS_ENABLED/);
  assert.match(textScanFeatureRow, /Upgrade to K\+/);
  assert.match(textScanFeatureRow, /Included with K\+/);
  assert.match(textScanFeatureRow, /KPlusGate/);
});

test('Voice Scan pill falls back to the legacy Coming Soon copy when the K+ boundary or Voice Scan itself is off', () => {
  assert.match(textScanFeatureRow, /if \(!VOICESCAN_ENABLED \|\| !KPLUS_EARLY_ACCESS_ENABLED\)/);
  assert.match(textScanFeatureRow, /Coming Soon/);
});

test('Voice Scan pill never opens a nonexistent feature for an active K+ member', () => {
  const block = textScanFeatureRow.slice(textScanFeatureRow.indexOf('function VoiceScanBlock'));
  assert.match(block, /disabled=\{isActive\}/);
  assert.match(block, /onPress=\{isActive \? undefined : openUpgrade\}/);
});

test('Voice Scan K+ pill hides behind VOICESCAN_ENABLED, not just the K+ boundary flag (Build 34 K+ Early Access shell, section 8)', () => {
  // A K+ entry point may not advertise a capability the build cannot
  // execute. Superseded by the Build 34 K+ Early Access Discovery +
  // Measurement Shell: the pill previously rendered whenever
  // KPLUS_EARLY_ACCESS_ENABLED was on, regardless of whether Voice Scan
  // itself was implemented.
  const block = textScanFeatureRow.slice(textScanFeatureRow.indexOf('function VoiceScanBlock'));
  assert.match(block, /if \(!VOICESCAN_ENABLED \|\| !KPLUS_EARLY_ACCESS_ENABLED\)/);
});

test('KPlusGate always renders the shared K+ Early Access sheet, never a feature-specific paywall', () => {
  assert.match(kPlusGate, /KPlusEarlyAccessSheet/);
});

test('K+ sheet uses complimentary-access language and never subscription/billing language', () => {
  assert.match(kPlusSheet, /Activate K\+ Early Access/);
  assert.match(kPlusSheet, /No payment is required\./);
  assert.match(kPlusSheet, /You will not be automatically charged when Early Access ends\./);
  for (const forbidden of [/\bsubscription\b/i, /\bsubscribe\b/i, /free trial/i, /cancel anytime/i, /\brenews\b/i]) {
    assert.doesNotMatch(kPlusSheet, forbidden);
  }
});

test('Account/Profile screen renders a K+ status row gated by auth and the feature flag', () => {
  assert.match(privacyScreen, /KPLUS_EARLY_ACCESS_ENABLED/);
  assert.match(privacyScreen, /useKPlusEntitlement/);
  assert.match(privacyScreen, /title="K\+"/);
  assert.doesNotMatch(privacyScreen, /Manage Subscription/);
});

test('Account/Profile K+ row never renders a "Manage Subscription" action (no subscription exists)', () => {
  const kPlusSection = privacyScreen.slice(
    privacyScreen.indexOf('isAuthenticated && KPLUS_EARLY_ACCESS_ENABLED'),
    privacyScreen.indexOf('isAuthenticated && KPLUS_EARLY_ACCESS_ENABLED') + 600,
  );
  assert.doesNotMatch(kPlusSection, /Manage Subscription/i);
});

test('logout/account-switch resets K+ cache via the same actor-scoped reset every other domain uses', () => {
  assert.match(authSessionContext, /resetKPlusEntitlementCache/);
  // Bounded by the function's own closing brace, not by a character count: a
  // fixed window silently starts excluding real lines as soon as anything is
  // added to the reset (a comment is enough), which turns a passing wiring
  // assertion into a false failure and, worse, could hide a genuine removal.
  const start = authSessionContext.indexOf('function resetActorScopedRuntimeState');
  assert.ok(start >= 0, 'the actor-scoped reset must exist');
  const end = authSessionContext.indexOf('\n}', start);
  assert.ok(end > start, 'the actor-scoped reset must be a closed function body');
  const fnBody = authSessionContext.slice(start, end);
  assert.match(fnBody, /resetKPlusEntitlementCache\(\)/);
});
