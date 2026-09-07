// Home Voice Scan K+ pill -- UI wiring hostile test suite.
//
// Static source-contract checks in the same style as
// __tests__/voiceScanUiWiring.test.js and __tests__/kplusSurfaceWiring.test.js:
// this repo has no Jest/RTL, so component behavior is proven by inspecting
// the actual shipped source for the invariants that matter.
//
// This pill is a PRESENTATION layer only. It must never own subscription
// state, trial state, VoiceScan eligibility, or microphone permission -- all
// of that stays in useKPlusEntitlement / KPlusGate / useVoiceScan, unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

const pill = read('components', 'home', 'HomeVoiceScanPill.tsx');
const homeV1 = read('components', 'home', 'HomeLuxuryTechV1.tsx');
// Comment-stripped view for checks that must ignore explanatory prose (which
// legitimately names VoiceScanButton/useVoiceScan while describing why this
// file must not call them) and only see actual code.
const pillCode = pill.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function kplusSources() {
  const src = read('types', 'kplusSource.ts');
  const block = src.match(/export const KPLUS_SOURCES = \[([\s\S]*?)\] as const;/);
  assert.ok(block, 'types/kplusSource.ts must export a literal KPLUS_SOURCES array');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `expected to find "${startMarker}"`);
  const end = endMarker ? source.indexOf(endMarker, start) : source.length;
  assert.ok(end > start, `expected to find "${endMarker}" after "${startMarker}"`);
  return source.slice(start, end);
}

// ── Placement (owner-directed) ──────────────────────────────────────────────

test('HomeVoiceScanPill is placed directly above TEXTSCAN, not inside the 2x2 grid', () => {
  const gridIndex = homeV1.indexOf('featuresRow');
  const pillIndex = homeV1.indexOf('<HomeVoiceScanPill');
  const secondaryRowIndex = homeV1.indexOf('secondaryActionsRow');
  const textScanIndex = homeV1.indexOf('title="TEXTSCAN"');
  assert.ok(gridIndex > 0 && pillIndex > gridIndex, 'pill must come after the feature grid');
  assert.ok(pillIndex < secondaryRowIndex, 'pill must sit above the secondary actions row');
  assert.ok(secondaryRowIndex < textScanIndex, 'TEXTSCAN must remain inside the secondary actions row, below the pill');
});

test('the 2x2 feature grid and stylist card are untouched by this change', () => {
  assert.match(homeV1, /title="RECENT SCANS"/);
  assert.match(homeV1, /title="VISUAL SEARCH"/);
  assert.match(homeV1, /title="CLOSET"/);
  assert.match(homeV1, /title="DRESSING ROOMS"/);
  assert.match(homeV1, /<HomeStylistCard/);
});

// ── Build-capability visibility (Section 5) ─────────────────────────────────

test('the pill is absent entirely when VOICESCAN_ENABLED is off, independent of K+', () => {
  const fnBody = sliceFn(pill, 'export function HomeVoiceScanPill', 'return (');
  assert.match(fnBody, /if \(!VOICESCAN_ENABLED\) return null;/);
});

test('the pill additionally requires native voice provisioning, same guard as VoiceScanButton', () => {
  const fnBody = sliceFn(pill, 'export function HomeVoiceScanPill', 'return (');
  assert.match(fnBody, /if \(!isVoicePlatformProvisioned\(getPlatform\(\)\)\) return null;/);
});

test('visibility never reads K+ entitlement -- only the two capability guards precede the K+ gate', () => {
  const fnBody = sliceFn(pill, 'export function HomeVoiceScanPill', '</KPlusGate>');
  const kplusGateIndex = fnBody.indexOf('<KPlusGate');
  const before = fnBody.slice(0, kplusGateIndex);
  assert.doesNotMatch(before, /isActive|useKPlusEntitlement/, 'no entitlement read before the gate opens');
});

// ── K+ presentation, shared primitive reuse (Sections 6, 13, 14) ────────────

test('the pill reuses the shared KPlusGate, never a bespoke paywall', () => {
  assert.match(pill, /import \{ KPlusGate \} from '\.\.\/kplus\/KPlusGate';/);
  assert.doesNotMatch(pill, /Modal|KPlusEarlyAccessSheet/, 'must not construct its own upgrade surface');
});

test('the KPlusGate source is a member of the bounded taxonomy, and is voice_scan (shared with the other Voice Scan surfaces)', () => {
  const sources = kplusSources();
  const match = pill.match(/<KPlusGate source="([^"]+)">/);
  assert.ok(match, 'HomeVoiceScanPill must render a KPlusGate with an explicit source');
  assert.ok(sources.includes(match[1]), `KPlusGate source "${match[1]}" is not in KPLUS_SOURCES`);
  assert.equal(match[1], 'voice_scan', 'must share attribution with VoiceScanButton and the TextScan info block, not a new source key');
});

test('RESOLVING (loading) never renders the K+/INCLUDED badge and is a tap no-op', () => {
  const inner = sliceFn(pill, 'function HomeVoiceScanPillInner', 'const styles');
  assert.match(inner, /const resolving = state === 'loading';/);
  const handlePress = sliceFn(inner, 'const handlePress =', 'const accessibilityLabel');
  assert.match(handlePress, /if \(resolving\) return;/);
  assert.match(inner, /disabled=\{resolving\}/);
  assert.match(inner, /\{!resolving && \(/, 'the badge must be suppressed while resolving');
});

test('RESOLVING never opens the K+ acquisition surface and never navigates', () => {
  const handlePress = sliceFn(pill, 'const handlePress =', 'const accessibilityLabel');
  // openUpgrade() and router.push() must both appear textually AFTER the
  // resolving early return, never before it.
  const resolvingReturnIndex = handlePress.indexOf('if (resolving) return;');
  const openUpgradeIndex = handlePress.indexOf('openUpgrade();');
  const navigateIndex = handlePress.indexOf("router.push('/text-scan')");
  assert.ok(resolvingReturnIndex >= 0 && openUpgradeIndex > resolvingReturnIndex);
  assert.ok(navigateIndex > resolvingReturnIndex);
});

test('LOCKED (not active, not resolving) opens the canonical shared K+ acquisition surface', () => {
  const handlePress = sliceFn(pill, 'const handlePress =', 'const accessibilityLabel');
  assert.match(handlePress, /if \(locked\) \{\s*openUpgrade\(\);\s*return;\s*\}/);
});

test('ENTITLED tap invokes the EXISTING VoiceScan runtime entry (TextScan), never a second eligibility path', () => {
  const handlePress = sliceFn(pill, 'const handlePress =', 'const accessibilityLabel');
  assert.match(handlePress, /router\.push\('\/text-scan'\)/);
  // Must be reached only after both the resolving and locked early returns.
  const lockedReturnIndex = handlePress.indexOf('return;\n    }');
  const navigateIndex = handlePress.indexOf("router.push('/text-scan')");
  assert.ok(navigateIndex > lockedReturnIndex);
});

test('this pill never imports or calls the VoiceScan functional entry directly -- TextScan/VoiceScanButton remains the single entry point', () => {
  assert.doesNotMatch(pillCode, /useVoiceScan|VoiceScanButton|startSession|requestVoiceRecordingPermission|beginVoiceListening/);
});

test('HomeLuxuryTechV1 does not gain a second Voice Scan functional entry point either', () => {
  assert.doesNotMatch(homeV1, /VoiceScanButton|useVoiceScan/);
});

// ── No LIVE label on an idle mic (owner-directed) ───────────────────────────

test('the pill never labels an idle microphone control "LIVE"', () => {
  assert.doesNotMatch(pill, /\bLIVE\b/);
});

test('the pill never claims "subscription" language -- K+ Early Access is complimentary, not a purchasable subscription today', () => {
  for (const forbidden of [/\bsubscription\b/i, /\bsubscribe\b/i]) {
    assert.doesNotMatch(pill, forbidden);
  }
});

// ── Accessibility (Section 16) ──────────────────────────────────────────────

test('accessibility label communicates the correct meaning per state, and LOCKED stays discoverable', () => {
  assert.match(pill, /Voice Scan, K Plus feature\. Checking your access\./);
  assert.match(pill, /Voice Scan, K Plus feature\. Starts voice search\./);
  assert.match(pill, /Voice Scan, K Plus feature, not currently available on your account\. Tap to learn more\./);
});

test('accessibilityRole is button and accessibilityState only disables the RESOLVING tap', () => {
  assert.match(pill, /accessibilityRole="button"/);
  assert.match(pill, /accessibilityState=\{\{ disabled: resolving \}\}/);
});

// ── Microphone stays JIT (Section 9) ─────────────────────────────────────────

test('no microphone permission API is reachable from this file', () => {
  for (const forbidden of [
    'requestVoiceRecordingPermission',
    'requestMicrophonePermissionsAsync',
    'useMicrophonePermissions',
    'useAudioRecorder',
    'AudioRecorder',
  ]) {
    assert.doesNotMatch(pill, new RegExp(forbidden));
  }
});

// NEGATIVE CONTROL -- prove the guard-ordering checks above actually bite.
test('NEGATIVE CONTROL: a mutant that opens the upgrade sheet before the resolving check would be caught', () => {
  const mutant = `
    const handlePress = () => {
      openUpgrade();
      if (resolving) return;
    };
  `;
  const resolvingReturnIndex = mutant.indexOf('if (resolving) return;');
  const openUpgradeIndex = mutant.indexOf('openUpgrade();');
  assert.ok(openUpgradeIndex < resolvingReturnIndex, 'mutant must fail the real ordering assertion');
});
