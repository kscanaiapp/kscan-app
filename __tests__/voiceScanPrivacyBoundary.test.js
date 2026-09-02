// Build 34 Voice Scan -- raw-audio privacy boundary, enforced as a test
// rather than as a comment.
//
// WHY THIS FILE EXISTS. services/voice/* and the two native modules carry
// prominent PRIVACY CONTRACT comments ("no cloud fallback", "no durable raw
// audio", "never createSpeechRecognizer()"). A Build 34 Voice Scan audit ran
// the required negative controls against the suite as it stood and found that
// several of those contracts were unenforced: a raw-audio HTTP upload added to
// services/voice/ (VS-NC-002), an ElevenLabs import into the recognition path
// (VS-NC-003), and a file write of the captured audio buffer in the iOS module
// (VS-NC-010) all left the governed suite fully green. Comments do not fail
// builds. These do.
//
// SCOPE. Deliberately a source-level scan: the invariants here are "this text
// must never appear in this layer", which is exactly what a reviewer would
// check by hand and exactly what gets missed under time pressure. Behavioral
// invariants live in voiceScanContract / voiceScanStateMachine /
// useVoiceScanSessionGuards; this file is the import/egress firewall.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readRaw = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * Source with comments removed.
 *
 * These files document their own prohibitions in prose ("never route Voice
 * audio through ElevenLabs", "no Supabase table is written here"), so a naive
 * text scan would fire on the very comments that state the rule. Stripping
 * comments first means these assertions can only ever fail on real code --
 * which is the point: a contract stated in a comment is what this file exists
 * to stop trusting.
 */
function read(...p) {
  return readRaw(...p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments (JS/TS, Swift, Kotlin)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // line comments, sparing "https://"
}

/** Every file that may touch a Voice Scan transcript or the microphone. */
const VOICE_JS_LAYER = [
  ['services', 'voice', 'voiceTypes.ts'],
  ['services', 'voice', 'voiceRecognition.ts'],
  ['services', 'voice', 'voiceStateMachine.ts'],
  ['services', 'voice', 'voiceTranscript.ts'],
  ['services', 'voice', 'voiceSubmission.ts'],
  ['services', 'voice', 'voiceTelemetry.ts'],
  ['services', 'voice', 'voiceNativeModule.ts'],
  ['hooks', 'useVoiceScan.ts'],
  ['components', 'text-scan', 'VoiceScanButton.tsx'],
  ['components', 'text-scan', 'VoiceListeningSheet.tsx'],
];

const IOS_NATIVE = ['modules', 'kscan-voice-native', 'ios', 'KScanVoiceNativeModule.swift'];
const ANDROID_NATIVE = [
  'modules', 'kscan-voice-native', 'android', 'src', 'main', 'java',
  'expo', 'modules', 'kscanvoicenative', 'KScanVoiceNativeModule.kt',
];

// ── VS-NC-002: no raw-audio egress path may exist in the Voice layer ────────

test('VS-NC-002: the Voice Scan JS layer contains no network egress primitive', () => {
  // The ONLY thing Voice Scan is allowed to send anywhere is a reviewed
  // transcript, and it sends that by handing text to the existing TextScan
  // submit path in app/text-scan -- never from inside services/voice.
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\baxios\b/,
    /\bWebSocket\b/,
    /supabase/i,
    /functions\.invoke/,
    /EdgeFunction|edge-function/i,
  ];
  for (const parts of VOICE_JS_LAYER) {
    const source = read(...parts);
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        source,
        pattern,
        `${parts.join('/')} must contain no network primitive (${pattern}) -- ` +
          'raw audio and unreviewed transcripts must have no way off the device from this layer',
      );
    }
  }
});

test('VS-NC-002: no audio serialization primitive exists in the Voice Scan JS layer', () => {
  const forbidden = [/FormData/, /\bBlob\b/, /base64/i, /btoa\s*\(/, /\bBuffer\b/, /multipart/i];
  for (const parts of VOICE_JS_LAYER) {
    const source = read(...parts);
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        source,
        pattern,
        `${parts.join('/')} must not be able to package audio for transport (${pattern})`,
      );
    }
  }
});

// ── VS-NC-003: Elise TTS and Voice Scan STT must never converge ─────────────

test('VS-NC-003: no cloud speech vendor is reachable from the Voice Scan layer', () => {
  // ElevenLabs is K Scan's Elise TEXT-TO-SPEECH vendor. It is not, and must
  // never become, a Voice Scan SPEECH-TO-TEXT provider: Voice Scan audio is
  // recognized on-device or not at all. The other names are the cloud STT
  // vendors a well-meaning "just make it work on this device" fix would reach
  // for.
  const vendors = [
    /elevenlabs/i,
    /whisper/i,
    /deepgram/i,
    /assemblyai/i,
    /speechmatics/i,
    /cloud[-_ ]?speech/i,
    /speech[-_ ]?to[-_ ]?text/i,
    /openai/i,
    /gemini/i,
    /openrouter/i,
  ];
  for (const parts of [...VOICE_JS_LAYER, IOS_NATIVE, ANDROID_NATIVE]) {
    const source = read(...parts);
    for (const pattern of vendors) {
      assert.doesNotMatch(
        source,
        pattern,
        `${parts.join('/')} must never reference a cloud speech vendor (${pattern})`,
      );
    }
  }
});

test('VS-NC-003: the Voice Scan layer never imports from the Elise speech/avatar stack', () => {
  for (const parts of VOICE_JS_LAYER) {
    const source = read(...parts);
    for (const spec of source.match(/from\s+'([^']+)'/g) ?? []) {
      assert.doesNotMatch(
        spec,
        /avatars?|stylistSpeech|avatarSpeech|elise/i,
        `${parts.join('/')} must not import from the Elise speech stack: ${spec}`,
      );
    }
  }
});

// ── VS-NC-010: raw audio must have nothing durable to delete ────────────────

test('VS-NC-010: neither native module writes captured audio to storage', () => {
  const iosForbidden = [
    /\.write\s*\(\s*to\s*:/,
    /FileManager/,
    /NSTemporaryDirectory/,
    /URL\(fileURLWithPath/,
    /AVAudioFile/,
    /AVAudioRecorder/,
    /UserDefaults/,
  ];
  const ios = read(...IOS_NATIVE);
  for (const pattern of iosForbidden) {
    assert.doesNotMatch(ios, pattern, `iOS module must not persist audio (${pattern})`);
  }

  const androidForbidden = [
    /FileOutputStream/,
    /java\.io\.File/,
    /openFileOutput/,
    /MediaRecorder/,
    /AudioRecord\b/,
    /SharedPreferences/,
    /cacheDir|filesDir|getExternalFilesDir/,
  ];
  const android = read(...ANDROID_NATIVE);
  for (const pattern of androidForbidden) {
    assert.doesNotMatch(android, pattern, `Android module must not persist audio (${pattern})`);
  }
});

test('VS-NC-010: the Voice Scan JS layer has no durable storage path at all', () => {
  for (const parts of VOICE_JS_LAYER) {
    const source = read(...parts);
    for (const pattern of [/AsyncStorage/, /SecureStore/, /expo-file-system/, /FileSystem\./, /MMKV/, /SQLite/i]) {
      assert.doesNotMatch(source, pattern, `${parts.join('/')} must hold no durable state (${pattern})`);
    }
  }
});

test('VS-NC-010: the Android recognizer discards raw audio buffers it is handed', () => {
  const android = read(...ANDROID_NATIVE);
  // onBufferReceived is Android's raw-PCM firehose. It must stay an empty
  // no-op: anything in that body is by definition handling raw audio.
  const match = android.match(/override fun onBufferReceived\(buffer: ByteArray\?\)\s*\{([^}]*)\}/);
  assert.ok(match, 'onBufferReceived must be explicitly implemented (as a no-op)');
  assert.equal(match[1].trim(), '', 'onBufferReceived must remain empty -- raw audio is never retained');
});

// ── No silent cloud recognizer on either platform ──────────────────────────

test('the native modules cannot construct a network-capable recognizer', () => {
  const ios = read(...IOS_NATIVE);
  assert.match(ios, /requiresOnDeviceRecognition = true/, 'iOS must pin on-device recognition');
  assert.doesNotMatch(ios, /requiresOnDeviceRecognition = false/, 'iOS must never relax the on-device flag');

  const android = read(...ANDROID_NATIVE);
  assert.match(android, /createOnDeviceSpeechRecognizer/, 'Android must use the on-device recognizer factory');
  // createSpeechRecognizer( is the cloud-capable factory. Assert no call to
  // it exists -- the on-device factory name does not contain this substring
  // preceded by a dot, so this cannot match the approved call.
  assert.doesNotMatch(
    android,
    /SpeechRecognizer\.createSpeechRecognizer\s*\(/,
    'Android must never fall back to the network-capable recognizer factory',
  );
});
