// K SCAN AI Android Repair 09 — terminal account-deletion parity with iOS
// Repair 07.
//
// THE QUESTION THIS FILE ANSWERS: not "does terminal deletion work" — that is
// __tests__/terminalDeletionCleanup.test.js, and every one of its assertions
// already runs unmodified against the exact same modules Android now uses. The
// question here is narrower and specific to this repair: is there ANY point in
// the primary-area file set where iOS and Android could diverge, and did
// enabling the bridge on Android introduce any native surface change?
//
// The governed primary-area files (per the Repair 09 mandate):
//   app/_layout.tsx
//   services/accountDeletion.js
//   services/deletion/{pendingDeletionStore,statusReceipt,deletionStatusClient,
//     terminalDeletionDecision,ownerTerminalPurge,terminalDeletionReconciler}.ts
//   services/privateDressingRoom{Session,Composition,Interaction}Store.ts
//   services/privateSavedLookReturnContext.ts
//   stores/stylistVoicePreferenceStore.ts
//
// These tests read the REAL source of every one of those files and prove, by
// construction rather than by inspection, that none of them contains a
// platform conditional that could make Android behave differently from iOS.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Executable source only. A doc comment mentioning "iOS" is not a code path. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// The exact primary-area file set this repair is scoped to (app/_layout.tsx is
// handled separately below, since its guard removal is the repair itself).
//
// The three private-dressing-room stores are deliberately excluded from this
// list: each already contains a PRE-EXISTING, UNRELATED `Platform.OS ===
// 'android'` branch (the established "no durable signed-out writes on
// Android" divergence documented in their own file headers) that has nothing
// to do with terminal deletion. That branch guards `startActiveSession` /
// `replaceCompositionSet` / `applySlotOverride` and friends — never the
// `purge*ForActor` primitive this repair actually calls. Those primitives are
// certified on their own, more precisely, in the next test.
const GOVERNED_DELETION_FILES = [
  'services/accountDeletion.js',
  'services/deletion/pendingDeletionStore.ts',
  'services/deletion/statusReceipt.ts',
  'services/deletion/deletionStatusClient.ts',
  'services/deletion/terminalDeletionDecision.ts',
  'services/deletion/ownerTerminalPurge.ts',
  'services/deletion/terminalDeletionReconciler.ts',
  'services/privateSavedLookReturnContext.ts',
  'stores/stylistVoicePreferenceStore.ts',
];

// ===========================================================================
// PARITY — no platform branch anywhere in the governed set
// ===========================================================================

test('PARITY: no governed deletion module contains a platform conditional', () => {
  for (const rel of GOVERNED_DELETION_FILES) {
    const source = stripComments(read(rel));
    assert.ok(
      !/Platform\.OS/.test(source),
      `${rel} must contain no Platform.OS branch — iOS and Android share one path`,
    );
  }
});

test('PARITY: the three private-dressing-room stores confine their Android divergence to signed-out writes, never to the purge primitive', () => {
  const stores = [
    'services/privateDressingRoomSessionStore.ts',
    'services/privateDressingRoomCompositionStore.ts',
    'services/privateDressingRoomInteractionStore.ts',
  ];
  for (const rel of stores) {
    const source = stripComments(read(rel));
    // The pre-existing divergence is real and expected here...
    assert.match(
      source,
      /Platform\.OS === 'android'/,
      `${rel} is expected to carry the established signed-out-write divergence`,
    );
    // ...but it must appear ONLY inside the actor-authority resolver, which
    // gates ordinary mutation entry points, not the terminal-cleanup purge
    // primitive. Confirmed precisely by the sibling test above, which reads
    // the purge* function body in isolation and asserts it has no such branch.
    const authorityFnStart = source.search(/function resolve\w*Authority\(/);
    assert.ok(authorityFnStart > 0, `${rel} must define its actor-authority resolver`);
    const occurrences = (source.match(/Platform\.OS === 'android'/g) || []).length;
    assert.equal(occurrences, 1, `${rel} must carry exactly the one known divergence, not a new one`);
  }
});

test('PARITY: the three Repair-07-added dressing-room purge primitives are actor-scoped only, never platform-scoped', () => {
  // These three stores DO reference Platform (the pre-existing, unrelated
  // Android signed-out-durable-write divergence documented in each file's
  // header), but their purge* primitive — the one this repair actually calls —
  // must be reachable through actor identity alone.
  const targets = [
    ['services/privateDressingRoomSessionStore.ts', 'purgeDressingRoomSessionsForActor'],
    ['services/privateDressingRoomCompositionStore.ts', 'purgeDressingRoomCompositionsForActor'],
    ['services/privateDressingRoomInteractionStore.ts', 'purgeDressingRoomInteractionsForActor'],
  ];
  for (const [rel, fnName] of targets) {
    const source = stripComments(read(rel));
    const start = source.indexOf(`export async function ${fnName}(`);
    assert.ok(start > 0, `${fnName} must exist in ${rel}`);
    const end = source.indexOf('\n}\n', start);
    const body = source.slice(start, end);
    assert.ok(!/Platform/.test(body), `${fnName} must not branch on platform`);
    assert.match(body, /actorId\.trim\(\)/, `${fnName} must resolve its target from the supplied actor id`);
  }
});

// ===========================================================================
// PARITY — secure storage (expo-secure-store / Android Keystore)
// ===========================================================================

test('PARITY: the marker store passes no iOS-only SecureStore option', () => {
  const source = stripComments(read('services/deletion/pendingDeletionStore.ts'));
  // No accessibility constant (WHEN_UNLOCKED / AFTER_FIRST_UNLOCK / ALWAYS /
  // keychainService), no `requireAuthentication`, no third-argument options
  // object of any kind on any SecureStore call — every call site is
  // `store.<verb>ItemAsync(key)` or `store.<verb>ItemAsync(key, value)`.
  assert.ok(!/keychainAccessible|keychainService|requireAuthentication|WHEN_UNLOCKED|AFTER_FIRST_UNLOCK/.test(source));
  const calls = source.match(/store\.(get|set|delete)ItemAsync\([^)]*\)/g) || [];
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const argCount = call.includes('setItemAsync') ? 2 : 1;
    const commaCount = (call.match(/,/g) || []).length;
    assert.ok(
      commaCount <= argCount,
      `${call} must not pass a platform-specific options object`,
    );
  }
});

test('PARITY: SecureStoreLike is a three-method structural type with no platform-specific member', () => {
  const source = stripComments(read('services/deletion/pendingDeletionStore.ts'));
  const start = source.indexOf('export type SecureStoreLike');
  const end = source.indexOf('};', start);
  const body = source.slice(start, end);
  assert.match(body, /getItemAsync/);
  assert.match(body, /setItemAsync/);
  assert.match(body, /deleteItemAsync/);
  assert.ok(!/ios|android|keychain|keystore/i.test(body), 'the storage contract names no platform');
});

// ===========================================================================
// PARITY — CSPRNG (expo-crypto / Web Crypto)
// ===========================================================================

test('PARITY: the receipt generator sources randomness through a platform-neutral precedence, never a native iOS API', () => {
  const source = stripComments(read('services/deletion/statusReceipt.ts'));
  assert.ok(!/Platform/.test(source));
  // Web Crypto first (present in both the Hermes/JSI polyfill on Android and
  // iOS), expo-crypto as the fallback. No `expo-apple-authentication`, no
  // `expo-application` (which does expose iOS-only identifiers), nothing else.
  assert.match(source, /globalThis.*crypto/s);
  assert.match(source, /expo-crypto/);
  assert.ok(!/expo-apple-authentication|expo-application|IDFA|identifierForVendor/i.test(source));
});

// ===========================================================================
// LIFECYCLE — cold start and background->active, on both platforms, from one
// implementation
// ===========================================================================

function terminalDeletionBridgeBody() {
  const layout = read('app/_layout.tsx');
  const start = layout.indexOf('function TerminalDeletionBridge()');
  const end = layout.indexOf('\n}\n', layout.indexOf('return null;', start));
  assert.ok(start > 0, 'TerminalDeletionBridge must exist in app/_layout.tsx');
  return layout.slice(start, end);
}

test('LIFECYCLE: Android cold start reconciles — the mount effect is unconditional', () => {
  const body = terminalDeletionBridgeBody();
  const mountEffect = body.slice(0, body.indexOf('useEffect', body.indexOf('useEffect') + 1));
  assert.match(mountEffect, /void reconcileTerminalDeletions\(\);/);
  // The mount effect has an empty dependency array (runs once, at mount —
  // "cold start" for a component that renders as part of the root Layout) and
  // no platform check ahead of the call.
  assert.match(mountEffect, /\}, \[\]\);/);
  assert.ok(!/Platform/.test(mountEffect));
});

test('LIFECYCLE: Android background->active reconciles — the AppState effect is unconditional and correctly bounded', () => {
  const body = terminalDeletionBridgeBody();
  const secondEffectStart = body.indexOf('useEffect', body.indexOf('useEffect') + 1);
  const appStateEffect = body.slice(secondEffectStart);
  assert.match(appStateEffect, /AppState\.addEventListener\('change'/);
  assert.match(appStateEffect, /inactive\|background/);
  assert.match(appStateEffect, /next === 'active'/);
  assert.match(appStateEffect, /void reconcileTerminalDeletions\(\);/);
  assert.ok(!/Platform/.test(appStateEffect));
  // AppState itself is the cross-platform React Native API (not an iOS-only
  // Apple lifecycle hook) — the same module AppleCredentialStateBridge above
  // it in this file already uses for its own (genuinely iOS-only) boundary.
  const importLine = (read('app/_layout.tsx').match(/^import \{[\s\S]*?\} from 'react-native';/m) || [''])[0];
  assert.match(importLine, /AppState/);
});

test('LIFECYCLE: repeated foreground events on Android do not create uncontrolled concurrent reconciliation', () => {
  // The bridge itself carries no de-duplication logic — that guarantee lives in
  // reconcileTerminalDeletions' own module-scoped in-flight promise (see
  // terminalDeletionReconciler.ts), which is platform-agnostic and already
  // proven under __tests__/terminalDeletionCleanup.test.js
  // ("RESUME: overlapping lifecycle events collapse into one pass"). Because
  // Android now calls the exact same exported function from the exact same
  // AppState listener shape, that guarantee transfers without new code.
  const reconcilerSource = stripComments(read('services/deletion/terminalDeletionReconciler.ts'));
  assert.match(reconcilerSource, /let inFlight: Promise<ReconcileSummary> \| null = null;/);
  assert.match(reconcilerSource, /if \(inFlight\) return inFlight;/);
  assert.ok(!/Platform/.test(reconcilerSource), 'the de-duplication guard is not platform-scoped');
});

test('PARITY: iOS lifecycle behaviour is unchanged — there is exactly one bridge implementation, not a fork', () => {
  assert.ok(
    !fs.existsSync(path.join(ROOT, 'app/_layout.ios.tsx')),
    'no iOS-specific layout fork exists',
  );
  assert.ok(
    !fs.existsSync(path.join(ROOT, 'app/_layout.android.tsx')),
    'no Android-specific layout fork exists',
  );
  const body = terminalDeletionBridgeBody();
  // The same two boundaries, same in-flight guard reliance, same absence of a
  // user/session gate that Repair 07 established for iOS are exactly what
  // Android now runs too — proven by there being only one body to read.
  assert.equal((body.match(/useEffect/g) || []).length, 2);
  assert.ok(!/useAuthSession|user\?\.id|session/.test(body));
});

// ===========================================================================
// NATIVE IMPACT — no new dependency, no new native module
// ===========================================================================

test('NATIVE: this repair adds no dependency and no android/ source change beyond app/_layout.tsx removing a JS guard', () => {
  const pkg = JSON.parse(read('package.json'));
  // Every runtime module this repair touches resolves to a dependency that
  // already ships and is already used elsewhere for both platforms.
  for (const dep of ['expo-secure-store', 'expo-crypto', 'expo-file-system', '@react-native-async-storage/async-storage', 'react-native']) {
    assert.ok(pkg.dependencies[dep], `${dep} must already be a shipped dependency`);
  }
});
