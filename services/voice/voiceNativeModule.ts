/**
 * Thin bridge from the platform-agnostic Voice Scan session logic
 * (voiceRecognition.ts, voiceStateMachine.ts) to the real native module.
 *
 * Deliberately declarative and small: it does not decide anything, it only
 * translates between modules/kscan-voice-native's raw shapes and this
 * app's VoiceNativeCapabilities/VoiceNativeFinalResult types. It is not
 * unit-tested via node --test (it imports react-native / expo-modules-core,
 * which need a real RN runtime); the logic worth testing lives in the pure
 * modules it wraps.
 */
import { Platform } from 'react-native';
import {
  KScanVoiceNativeModule,
  getVoiceCapabilities,
  requestVoicePermissions,
  startVoiceListening,
  stopVoiceListening,
  cancelVoiceListening,
  type KScanVoiceCapabilities,
  type KScanVoiceFinalResult,
  type KScanVoicePartialTranscriptEvent,
  type KScanVoiceSessionEndedEvent,
} from '../../modules/kscan-voice-native';
import type {
  VoiceNativeCapabilities,
  VoiceNativeFinalResult,
  VoiceRuntimePlatform,
} from './voiceRecognition';

export function getPlatform(): VoiceRuntimePlatform {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  if (Platform.OS === 'web') return 'web';
  return 'unknown';
}

function toNativeFinalResult(raw: KScanVoiceFinalResult | null | undefined): VoiceNativeFinalResult | null {
  if (!raw) return null;
  return {
    transcript: typeof raw.transcript === 'string' ? raw.transcript : '',
    locale: raw.locale ?? null,
    onDevice: raw.onDevice === true,
  };
}

export async function fetchVoiceCapabilities(): Promise<VoiceNativeCapabilities> {
  const raw: KScanVoiceCapabilities = await getVoiceCapabilities();
  return {
    supported: raw.supported === true,
    onDeviceAvailable: raw.onDeviceAvailable === true,
    platform: getPlatform(),
  };
}

export async function requestVoiceRecordingPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
  return requestVoicePermissions();
}

export async function beginVoiceListening(locale?: string): Promise<void> {
  await startVoiceListening(locale ? { locale } : {});
}

/** Resolves with the final transcript for an explicit, JS-initiated stop. */
export async function endVoiceListening(): Promise<VoiceNativeFinalResult | null> {
  const result = await stopVoiceListening();
  return toNativeFinalResult(result);
}

export async function abandonVoiceListening(): Promise<void> {
  await cancelVoiceListening();
}

export interface VoiceNativeEventHandlers {
  onPartialTranscript?: (transcript: string) => void;
  /**
   * Fires only when the OS ended the session on its own (15s cap, natural
   * end-of-speech) -- never as a result of an explicit stop/cancel call,
   * which resolve their own promise instead.
   */
  onSessionEndedByNative?: (result: VoiceNativeFinalResult | null) => void;
}

/** Subscribes to native session events; returns an unsubscribe function. */
export function subscribeToVoiceEvents(handlers: VoiceNativeEventHandlers): () => void {
  const subscriptions: { remove: () => void }[] = [];

  if (handlers.onPartialTranscript) {
    const onPartialTranscript = handlers.onPartialTranscript;
    subscriptions.push(
      KScanVoiceNativeModule.addListener('onPartialTranscript', (event: KScanVoicePartialTranscriptEvent) => {
        onPartialTranscript(typeof event?.transcript === 'string' ? event.transcript : '');
      }),
    );
  }

  if (handlers.onSessionEndedByNative) {
    const onSessionEndedByNative = handlers.onSessionEndedByNative;
    subscriptions.push(
      KScanVoiceNativeModule.addListener('onSessionEnded', (event: KScanVoiceSessionEndedEvent) => {
        onSessionEndedByNative(toNativeFinalResult(event?.result));
      }),
    );
  }

  return () => {
    for (const sub of subscriptions) sub.remove();
  };
}
