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

// ── Flag gating ──────────────────────────────────────────────────────────

test('VoiceScanButton renders nothing at all when VOICESCAN_ENABLED is off', () => {
  const fnBody = voiceScanButton.slice(voiceScanButton.indexOf('export function VoiceScanButton'));
  assert.match(fnBody, /if \(!VOICESCAN_ENABLED\) return null;/);
});

test('VoiceScanButton is the single K Scan entry point wired to Voice Scan (Home is untouched)', () => {
  assert.doesNotMatch(read('components', 'home', 'HomeLuxuryTechV1.tsx'), /VoiceScanButton|useVoiceScan/);
});

// ── K+ reuse, no second paywall ──────────────────────────────────────────

test('VoiceScanButton gates via the shared KPlusGate, never a Voice-specific paywall component', () => {
  assert.match(voiceScanButton, /import \{ KPlusGate \} from '\.\.\/kplus\/KPlusGate';/);
  assert.match(voiceScanButton, /<KPlusGate source="voice_scan_mic">/);
  assert.doesNotMatch(voiceScanButton, /Modal[\s\S]{0,200}Upgrade/); // no ad-hoc upgrade modal
});

test('tapping the mic while K+ is inactive opens the existing upgrade sheet and never starts a session', () => {
  const handlePress = voiceScanButton.slice(
    voiceScanButton.indexOf('const handlePress ='),
    voiceScanButton.indexOf('const sheetVisible ='),
  );
  assert.match(handlePress, /if \(!isKPlusActive\) \{\s*openUpgrade\(\);\s*return;\s*\}/);
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
  assert.match(textScanScreen, /rightAccessory=\{<VoiceScanButton onTranscript=\{setQuery\} disabled=\{isSubmitting\} \/>\}/);
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
