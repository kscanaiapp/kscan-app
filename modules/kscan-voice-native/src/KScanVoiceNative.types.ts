/**
 * Raw native-boundary types for the on-device speech adapter.
 *
 * These are deliberately narrow and know nothing about Commerce, K+, or
 * TextScan -- the native layer's only job is "listen, and hand back what
 * was said (or why it couldn't)". services/voice/voiceRecognition.ts is
 * where a raw result gets turned into the app-facing VoiceTranscript, and
 * it re-derives `onDevice` itself rather than trusting this layer blindly.
 */

export type KScanVoicePlatform = 'ios' | 'android' | 'web';

export interface KScanVoiceCapabilities {
  /** True when a speech-recognition API exists on this device at all. */
  supported: boolean;
  /**
   * True only when that API can run in a guaranteed on-device-only mode
   * right now, for the current locale. This is re-checked on every
   * `startListening` call -- capability can change device-to-device and,
   * on Android, OEM-to-OEM.
   */
  onDeviceAvailable: boolean;
  platform: KScanVoicePlatform;
}

export interface KScanVoiceStartOptions {
  /** BCP-47 locale, e.g. "en-US". Defaults to the device locale natively. */
  locale?: string;
}

/** Why a listening session ended without the caller calling stopListening(). */
export type KScanVoiceSessionEndedReason =
  | 'max_duration_reached'
  | 'recognizer_finalized'
  | 'no_speech'
  | 'error'
  | 'interrupted';

export interface KScanVoiceSessionEndedEvent {
  reason: KScanVoiceSessionEndedReason;
  /** Present only for reason "error". */
  errorCode?: string;
  /**
   * Present only when the session finalized with usable speech
   * (reason "max_duration_reached" or "recognizer_finalized") and no
   * JS-initiated stopListening() call was pending -- i.e. the OS ended the
   * session on its own and this event is the only way JS learns the
   * result. Absent for "error"/"interrupted", where there is nothing
   * usable to hand back.
   */
  result?: KScanVoiceFinalResult;
}

export interface KScanVoicePartialTranscriptEvent {
  transcript: string;
}

/** The only shape a finalized recognition result may take. */
export interface KScanVoiceFinalResult {
  transcript: string;
  locale: string | null;
  /**
   * True only when this transcript was produced by a guaranteed on-device
   * recognition pass. A native implementation must never set this true
   * unless it enforced on-device-only recognition for the whole session
   * (`requiresOnDeviceRecognition` on iOS, `createOnDeviceSpeechRecognizer`
   * on Android) -- there is no cloud fallback path that is allowed to set
   * this true.
   */
  onDevice: boolean;
}

export type KScanVoiceErrorCode =
  | 'PERMISSION_DENIED'
  | 'ON_DEVICE_RECOGNITION_UNAVAILABLE'
  | 'ALREADY_LISTENING'
  | 'NOT_LISTENING'
  | 'RECOGNIZER_ERROR'
  | 'AUDIO_SESSION_ERROR';

export interface KScanVoiceNativeModuleType {
  getCapabilities(): Promise<KScanVoiceCapabilities>;
  /** Requests OS-level microphone (and, on iOS, speech-recognition) permission. */
  requestPermissions(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  /** Begins a listening session. Rejects if one is already active. */
  startListening(options: KScanVoiceStartOptions): Promise<void>;
  /**
   * User-initiated stop: finalizes recognition and resolves with the final
   * result, or null if no usable speech was captured.
   */
  stopListening(): Promise<KScanVoiceFinalResult | null>;
  /**
   * Abandons the current session without returning a transcript. Any
   * partial transcript captured so far is discarded, not returned.
   */
  cancelListening(): Promise<void>;
}
