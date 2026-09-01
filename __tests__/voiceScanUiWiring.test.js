// Voice Scan V1 -- UI wiring hostile test suite.
//
// Static source-contract checks in the same style as
// __tests__/kplusSurfaceWiring.test.js: this repo has no Jest/RTL, so
// component behavior that can't be exercised via node --test's pure-module
// loader is instead proven by inspecting the actual shipped source for the
// invariants that matter -- same technique, same confidence level, already
// established elsewhere in this suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

const voiceScanButton = read('components', 'text-scan', 'VoiceScanButton.tsx');
const voiceListeningSheet = read('components', 'text-scan', 'VoiceListeningSheet.tsx');
const useVoiceScan = read('hooks', 'useVoiceScan.ts');
const textScanInput = read('components', 'text-scan', 'TextScanInput.tsx');
const textScanScreen = read('app', 'text-scan', 'index.tsx');
const voiceNativeModule = read('services', 'voice', 'voiceNativeModule.ts');
const voiceNativeTypes = read('modules', 'kscan-voice-native', 'src', 'KScanVoiceNative.types.ts');
const iosVoiceNative = read('modules', 'kscan-voice-native', 'ios', 'KScanVoiceNativeModule.swift');
const androidVoiceNative = read(
  'modules',
  'kscan-voice-native',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'kscanvoicenative',
  'KScanVoiceNativeModule.kt',
);

// ── Flag gating ──────────────────────────────────────────────────────────

test('VoiceScanButton renders nothing at all when VOICESCAN_ENABLED is off', () => {
  const fnBody = voiceScanButton.slice(voiceScanButton.indexOf('export function VoiceScanButton'));
  assert.match(fnBody, /if \(!VOICESCAN_ENABLED\) return null;/);
});

test('VoiceScanButton renders nothing on a platform whose native permission config is absent', () => {
  // Without this the shared `staging-certification` profile would put a
  // working-looking mic button into an iOS build with no usage strings, and
  // iOS terminates the app when the speech/mic APIs are called without them.
  const fnBody = voiceScanButton.slice(voiceScanButton.indexOf('export function VoiceScanButton'));
  assert.match(fnBody, /if \(!isVoicePlatformProvisioned\(getPlatform\(\)\)\) return null;/);
  // And it must run BEFORE any hook or gate that could request permission.
  assert.ok(
    fnBody.indexOf('isVoicePlatformProvisioned') < fnBody.indexOf('KPlusGate'),
    'the platform guard must precede the K+ gate and any session start',
  );
});

test('VoiceScanButton is the single K Scan entry point wired to Voice Scan (Home is untouched)', () => {
  assert.doesNotMatch(read('components', 'home', 'HomeLuxuryTechV1.tsx'), /VoiceScanButton|useVoiceScan/);
});

// ── K+ reuse, no second paywall ──────────────────────────────────────────

test('VoiceScanButton gates via the shared KPlusGate, never a Voice-specific paywall component', () => {
  assert.match(voiceScanButton, /import \{ KPlusGate \} from '\.\.\/kplus\/KPlusGate';/);
  assert.doesNotMatch(voiceScanButton, /Modal[\s\S]{0,200}Upgrade/); // no ad-hoc upgrade modal
});

// CONVERGENCE (Build 34 Android certification): the donor Voice lineage
// (PR #218) pinned the literal source "voice_scan_mic". That value does not
// exist in THIS lineage's bounded K+ source taxonomy (types/kplusSource.ts,
// Build 34 K+ Early Access shell section 9), which post-dates the donor
// branch. Keeping the donor literal would have compiled and shipped, then
// silently normalized to 'unknown' at the telemetry boundary
// (toKPlusSource), losing exactly the attribution the shell was built to
// preserve. The newer bounded taxonomy is authoritative, so the assertion is
// rewritten to enforce membership in it rather than one hardcoded string --
// a strictly stronger check than the literal it replaces.

/** The bounded K+ source list, read from its single source of truth. */
function kplusSources() {
  const src = read('types', 'kplusSource.ts');
  const block = src.match(/export const KPLUS_SOURCES = \[([\s\S]*?)\] as const;/);
  assert.ok(block, 'types/kplusSource.ts must export a literal KPLUS_SOURCES array');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the VoiceScanButton KPlusGate source is a member of the bounded K+ source taxonomy', () => {
  const sources = kplusSources();
  const match = voiceScanButton.match(/<KPlusGate source="([^"]+)">/);
  assert.ok(match, 'VoiceScanButton must render a KPlusGate with an explicit source');
  assert.ok(
    sources.includes(match[1]),
    `KPlusGate source "${match[1]}" is not in KPLUS_SOURCES -- it would normalize to 'unknown'`,
  );
  assert.equal(match[1], 'voice_scan', 'Voice Scan is attributed to the voice_scan surface');
});

test('CONTROL: an out-of-taxonomy KPlusGate source would be caught', () => {
  // Without this, the membership assertion above could pass on a parser that
  // returned everything. Proves it bites on the donor branch's own literal.
  const sources = kplusSources();
  assert.ok(sources.length > 1, 'the taxonomy parser must actually find the list');
  assert.equal(sources.includes('voice_scan_mic'), false);
});

test('tapping the mic while K+ is inactive opens the existing upgrade sheet and never starts a session', () => {
  const handlePress = voiceScanButton.slice(
    voiceScanButton.indexOf('const handlePress ='),
    voiceScanButton.indexOf('const sheetVisible ='),
  );
  assert.match(handlePress, /if \(!isKPlusActive\) \{\s*openUpgrade\(\);\s*return;\s*\}/);
});

test('the actionable Voice Scan control keeps visible K+ identity in locked and active states', () => {
  assert.match(voiceScanButton, />VOICE SCAN</);
  assert.match(voiceScanButton, />K\+</);
  assert.match(voiceScanButton, /UPGRADE TO K\+/);
  assert.match(voiceScanButton, /INCLUDED · TAP TO SPEAK/);
});

// ── No silent mic: permission/listening only ever start from an explicit tap ──

function extractVoiceScanUseEffectBodies(source) {
  // Balanced-paren extraction of every `useEffect(...)` call, robust to
  // both block-bodied (`() => { ... }`) and expression-bodied
  // (`() => subscribeToVoiceEvents({...})`) arrow functions -- a plain
  // regex can't reliably capture both shapes in one pattern.
  const bodies = [];
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf('useEffect(', searchFrom);
    if (start === -1) break;
    let depth = 0;
    let i = start + 'useEffect('.length - 1; // index of the opening '('
    let end = -1;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    bodies.push(source.slice(start, end + 1));
    searchFrom = end + 1;
  }
  return bodies;
}

test('NO SILENT MIC: startSession is only ever invoked from VoiceScanButton\'s onPress handler, never from a bare mount effect', () => {
  const effectBodies = extractVoiceScanUseEffectBodies(useVoiceScan);
  assert.ok(effectBodies.length >= 2, `expected at least the draft-clear and event-subscription effects, found ${effectBodies.length}`);
  for (const body of effectBodies) {
    assert.doesNotMatch(body, /startSession\(/, 'no useEffect body may call startSession directly');
    assert.doesNotMatch(body, /beginVoiceListening\(/, 'no useEffect body may start native listening directly');
    assert.doesNotMatch(body, /requestVoiceRecordingPermission\(/, 'no useEffect body may request mic permission directly');
  }
});

test('NO SILENT MIC: beginVoiceListening / requestVoiceRecordingPermission appear ONLY inside startSession', () => {
  const startSessionBody = useVoiceScan.slice(
    useVoiceScan.indexOf('const startSession = useCallback('),
    useVoiceScan.indexOf('const stopSession = useCallback('),
  );
  assert.match(startSessionBody, /requestVoiceRecordingPermission\(/);
  assert.match(startSessionBody, /beginVoiceListening\(/);

  const withoutStartSession =
    useVoiceScan.slice(0, useVoiceScan.indexOf('const startSession = useCallback(')) +
    useVoiceScan.slice(useVoiceScan.indexOf('const stopSession = useCallback('));
  assert.doesNotMatch(withoutStartSession, /beginVoiceListening\(/);
  assert.doesNotMatch(withoutStartSession, /requestVoiceRecordingPermission\(/);
});

test('mic tap only calls startSession when K+ is active -- never unconditionally', () => {
  const handlePress = voiceScanButton.slice(
    voiceScanButton.indexOf('const handlePress ='),
    voiceScanButton.indexOf('const sheetVisible ='),
  );
  assert.match(handlePress, /void voice\.startSession\(\);/);
  // startSession call must be textually after the isKPlusActive early return.
  assert.ok(handlePress.indexOf('if (!isKPlusActive)') < handlePress.indexOf('voice.startSession()'));
});

// NEGATIVE CONTROL: a mutant hook that auto-starts listening on mount --
// prove the "no bare mount effect" check above actually catches it.
test('NEGATIVE CONTROL: a mutant hook that auto-starts on mount is caught by the no-silent-mic check', () => {
  const mutantSource = `
    useEffect(() => {
      void startSession();
    }, []);
  `;
  function hasSilentAutoStart(source) {
    return extractVoiceScanUseEffectBodies(source).some((body) => /startSession\(/.test(body));
  }
  assert.equal(hasSilentAutoStart(mutantSource), true, 'mutant must be detected as auto-starting');
  assert.equal(hasSilentAutoStart(useVoiceScan), false, 'real hook must not auto-start');
});

// ── Review is mandatory / convergence with the existing TextScan path ────

test('a finalized transcript populates the EXISTING TextScan query field, never a second input/screen', () => {
  assert.match(textScanScreen, /rightAccessory=\{[\s\S]*<VoiceScanButton[\s\S]*setQuery\(transcript\)[\s\S]*setQuerySource\('voicescan'\)/);
});

test('a reviewed Voice transcript reaches the existing authenticated TextScan call with the fixed voicescan source', () => {
  assert.match(textScanScreen, /querySource === 'voicescan'[\s\S]*buildVoiceSubmitOptions\(query\)/);
  assert.match(textScanScreen, /analyzeTextWithEdge\(query, invokeOptions\)/);
  assert.doesNotMatch(textScanScreen, /analyzeTextWithEdge\(query, \{ source: 'textscan' \}\)/);
});

test('VoiceScanButton never renders its own submit/search button -- it hands the transcript back and stops', () => {
  assert.doesNotMatch(voiceScanButton, /Analyze Request|onSubmit|handleSubmit/);
});

test('reviewing state is consumed via acceptDraft, not auto-submitted', () => {
  const effect = voiceScanButton.slice(
    voiceScanButton.indexOf("useEffect(() => {\n    if (voice.state === 'reviewing')"),
    voiceScanButton.indexOf('const handlePress ='),
  );
  assert.match(effect, /onTranscript\(voice\.acceptDraft\(\)\)/);
});

// ── Listening UX ───────────────────────────────────────────────────────────

test('the listening sheet exposes explicit Stop and Cancel controls, and respects reduced motion', () => {
  assert.match(voiceListeningSheet, /testID="voice-scan-stop"/);
  assert.match(voiceListeningSheet, /testID="voice-scan-cancel"/);
  assert.match(voiceListeningSheet, /isReduceMotionEnabled/);
});

test('permission-denied / on-device-unavailable states always offer "Use Text Instead", never a dead end', () => {
  assert.match(voiceListeningSheet, /Use Text Instead/);
  for (const reason of ['permission_denied', 'permission_denied_permanently', 'on_device_recognition_unavailable']) {
    assert.match(voiceListeningSheet, new RegExp(reason + ':'));
  }
});

test('the TextScan text input remains fully editable and independent of Voice Scan state', () => {
  assert.match(textScanInput, /editable=\{!disabled\}/);
  assert.doesNotMatch(textScanInput, /VOICESCAN_ENABLED|useVoiceScan/);
});

// ── Native routing invariant at the integration boundary ──────────────────

test('the native bridge module never references Commerce/Elise/retailer/Supabase concepts', () => {
  for (const forbidden of [/supabase/i, /scan-identify/, /commerce/i, /elise/i, /retailer/i]) {
    assert.doesNotMatch(voiceNativeModule, forbidden);
  }
});

test('rapid taps, entitlement loss, and unmount all invalidate the active session before native cleanup', () => {
  assert.match(useVoiceScan, /stateRef\.current[\s\S]*includes\(stateRef\.current\)\) return;/);
  assert.match(useVoiceScan, /isKPlusActiveRef\.current = isKPlusActive;[\s\S]*activeSessionIdRef\.current = null;[\s\S]*abandonVoiceListening\(sessionId\)/);
  assert.match(useVoiceScan, /useEffect\(\(\) => \(\) => \{[\s\S]*activeSessionIdRef\.current = null;[\s\S]*abandonVoiceListening\(sessionId\)/);
});

test('native callbacks and stop/cancel calls are bound to one opaque session identity on both platforms', () => {
  assert.match(voiceNativeTypes, /sessionId: string/);
  assert.match(voiceNativeModule, /event\?\.sessionId/);
  assert.match(iosVoiceNative, /activeSessionId == sessionId/);
  assert.match(iosVoiceNative, /"sessionId": sessionId/);
  assert.match(androidVoiceNative, /activeSessionId != sessionId/);
  assert.match(androidVoiceNative, /"sessionId" to sessionId/);
});

test('NEGATIVE CONTROL: a callback without session identity fails the stale-event contract', () => {
  const staleUnsafeEvent = 'sendEvent("onSessionEnded", ["reason": "interrupted"])';
  const hasBoundSession = (source) => /sessionId/.test(source);
  assert.equal(hasBoundSession(staleUnsafeEvent), false);
  assert.equal(hasBoundSession(iosVoiceNative), true);
  assert.equal(hasBoundSession(androidVoiceNative), true);
});

test('Android voice recognizer work and lifecycle registration stay on the main thread', () => {
  assert.match(androidVoiceNative, /import expo\.modules\.kotlin\.functions\.Queues/);
  assert.equal(
    (androidVoiceNative.match(/\.runOnQueue\(Queues\.MAIN\)/g) ?? []).length,
    5,
  );
  assert.match(androidVoiceNative, /OnCreate \{\s*handler\.post \{/);
  assert.match(androidVoiceNative, /OnDestroy \{[\s\S]*?handler\.post \{/);
});
