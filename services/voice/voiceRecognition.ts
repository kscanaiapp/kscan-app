/**
 * Pure Voice Scan recognition-result logic. No native module, no
 * react-native, no Commerce/backend imports -- this file only shapes and
 * guards the data a platform recognizer hands back, so it can be unit
 * tested in complete isolation from the app runtime.
 *
 * The load-bearing invariant enforced here: a VoiceTranscript can only ever
 * claim `onDevice: true` when the native layer's result literally said
 * `onDevice === true`. Any other value -- false, undefined, a truthy
 * non-boolean -- collapses the result to engine 'unavailable' with an empty
 * transcript. This is a second, independent enforcement of "no silent cloud
 * fallback" in front of whatever the native layer does, not a replacement
 * for it.
 */
import type { VoiceEngine, VoiceSourceSurface, VoiceTranscript } from './voiceTypes';

export type VoiceRuntimePlatform = 'ios' | 'android' | 'web' | 'unknown';

export interface VoiceNativeCapabilities {
  /** True when the platform recognition API exists and can be invoked at all. */
  supported: boolean;
  /** True only when that API can run in a guaranteed on-device-only mode. */
  onDeviceAvailable: boolean;
  platform: VoiceRuntimePlatform;
}

/** Raw finalized result as handed back by a platform native binding. */
export interface VoiceNativeFinalResult {
  transcript: string;
  locale: string | null;
  onDevice: boolean;
}

/** Voice Scan is usable for this attempt only when both flags are true. */
export function isVoiceRecognitionAvailable(caps: VoiceNativeCapabilities): boolean {
  return caps.supported === true && caps.onDeviceAvailable === true;
}

/**
 * Platforms whose NATIVE PERMISSION CONFIGURATION for Voice Scan is actually
 * present in the artifact this repository builds.
 *
 * This is deliberately separate from `isVoiceRecognitionAvailable`, which
 * describes the recognizer and is platform-neutral by design. This one
 * describes *this repository's build configuration*, which is not.
 *
 * WHY IT EXISTS. `EXPO_PUBLIC_VOICESCAN_ENABLED` is set in the
 * `staging-certification` EAS profile, and an EAS profile's `env` is
 * profile-level, not platform-level -- the same profile also declares
 * `ios.buildConfiguration`. So turning Voice on for the Android certification
 * AAB necessarily turns the flag on for anything built from that profile,
 * including iOS.
 *
 * WHAT THE HAZARD IS. iOS is CNG_AUTHORITATIVE, so `app.json` IS the
 * Info.plist. `SFSpeechRecognizer.requestAuthorization` and
 * `AVAudioSession.requestRecordPermission` TERMINATE the app when their usage
 * string is missing, so a flag-on iOS build without those strings crashes on
 * the first Voice tap. The capability probe alone would NOT catch it:
 * `getCapabilities` only reads `supportsOnDeviceRecognition`, which needs no
 * authorization, so the crash lands after the availability check passes.
 *
 * iOS WAS unprovisioned on this lineage, because expo-camera and expo-audio
 * were configured with `microphonePermission: false` -- which Expo's
 * createPermissionsPlugin treats as DELETE, actively removing the microphone
 * key from the BUILT plist (the Build 34 iOS lesson from PR #222).
 *
 * iOS IS NOW PROVISIONED. The Voice Scan recovery restored PR #222's repair
 * onto this lineage: both usage strings are declared in `app.json`, and BOTH
 * plugins carry the same custom microphone string rather than `false`, so
 * neither deletes the key nor injects a competing generic copy. The generated
 * plist is asserted directly in
 * __tests__/voiceScanMicrophonePermission.test.js, and the two strings are
 * reviewed for Apple-facing accuracy in __tests__/iosAppReviewSurface.test.js.
 *
 * This list stays the single place the per-platform decision is expressed, and
 * `__tests__/voiceScanContract.test.js` DERIVES its expectation from app.json
 * rather than asserting a constant -- so if the plist strings are ever removed
 * again, the test says to drop the platform instead of silently disagreeing
 * with the artifact.
 */
export const VOICE_NATIVE_PROVISIONED_PLATFORMS: readonly VoiceRuntimePlatform[] = ['android', 'ios'];

/**
 * Whether Voice Scan may render at all on this platform, given what this
 * repository's native configuration actually provides. Fails closed: an
 * unknown platform is never provisioned.
 */
export function isVoicePlatformProvisioned(platform: VoiceRuntimePlatform): boolean {
  return VOICE_NATIVE_PROVISIONED_PLATFORMS.includes(platform);
}

/**
 * Which engine produced (or failed to produce) a transcript.
 *
 * `onDevice` must be the strict boolean `true` to credit either platform
 * engine -- anything else (false, undefined, 1, "true", ...) is treated as
 * "not proven on-device" and forced to 'unavailable'.
 */
export function resolveVoiceEngine(
  platform: VoiceRuntimePlatform,
  onDevice: unknown,
): VoiceEngine {
  if (onDevice !== true) return 'unavailable';
  if (platform === 'ios') return 'ios-speech';
  if (platform === 'android') return 'android-speech';
  return 'unavailable';
}

/**
 * Build the VoiceTranscript the review screen will render from a raw
 * native result. This is the single seam every platform's finalized
 * recognition result must pass through -- callers must never construct a
 * VoiceTranscript by hand.
 */
export function buildVoiceTranscript(
  final: VoiceNativeFinalResult,
  platform: VoiceRuntimePlatform,
  sourceSurface: VoiceSourceSurface = 'text-scan',
  nowIso: () => string = () => new Date().toISOString(),
): VoiceTranscript {
  const engine = resolveVoiceEngine(platform, final?.onDevice);
  const proven = engine !== 'unavailable';
  return {
    transcript: proven && typeof final?.transcript === 'string' ? final.transcript : '',
    locale: proven ? final?.locale ?? null : null,
    onDevice: proven,
    engine,
    sourceSurface,
    capturedAt: nowIso(),
  };
}
