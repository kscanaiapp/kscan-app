// Static source-contract checks for the K+ product surfaces on Android: the
// Home screen Voice Scan pill conversion (Coming Soon -> Upgrade to K+ /
// Included with K+ -- HomeLuxuryTechV1 is the only one of the three
// duplicated Home implementations actually reachable, see app/index.tsx),
// the TextScan screen's placeholder (same conversion as iOS), and the
// Account/Profile K+ status row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const homeLuxuryTechV1 = fs.readFileSync(
  path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'),
  'utf8',
);
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

test('Home screen Voice Scan pill shows the K+ acquisition copy, gated by KPLUS_EARLY_ACCESS_ENABLED', () => {
  assert.match(homeLuxuryTechV1, /KPLUS_EARLY_ACCESS_ENABLED/);
  assert.match(homeLuxuryTechV1, /UPGRADE TO K\+/);
  assert.match(homeLuxuryTechV1, /INCLUDED WITH K\+/);
  assert.match(homeLuxuryTechV1, /KPlusGate/);
});

test('Home screen Voice Scan pill falls back to the legacy Coming Soon copy when the K+ boundary is off', () => {
  assert.match(homeLuxuryTechV1, /if \(KPLUS_EARLY_ACCESS_ENABLED\)/);
  assert.match(homeLuxuryTechV1, /COMING SOON/);
});

test('Home screen Voice Scan pill never opens a nonexistent feature for an active K+ member', () => {
  const block = homeLuxuryTechV1.slice(homeLuxuryTechV1.indexOf('function VoiceScanKPlusPill'));
  assert.match(block, /disabled=\{isActive\}/);
  assert.match(block, /onPress=\{isActive \? undefined : openUpgrade\}/);
});

test('this build does not change VOICESCAN_ENABLED itself (unrelated mic-permission flag)', () => {
  assert.match(homeLuxuryTechV1, /const inactive = !VOICESCAN_ENABLED;/);
});

test('TextScan screen placeholder gets the same K+ conversion as the Home pill', () => {
  assert.match(textScanFeatureRow, /KPLUS_EARLY_ACCESS_ENABLED/);
  assert.match(textScanFeatureRow, /Upgrade to K\+/);
  assert.match(textScanFeatureRow, /Included with K\+/);
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

test('logout/account-switch resets K+ cache via the same actor-scoped reset every other domain uses', () => {
  assert.match(authSessionContext, /resetKPlusEntitlementCache/);
  const fnBody = authSessionContext.slice(
    authSessionContext.indexOf('function resetActorScopedRuntimeState'),
    authSessionContext.indexOf('function resetActorScopedRuntimeState') + 1200,
  );
  assert.match(fnBody, /resetKPlusEntitlementCache\(\)/);
});
