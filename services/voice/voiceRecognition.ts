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
