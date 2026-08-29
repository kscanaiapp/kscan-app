import KScanVoiceNativeModule from './KScanVoiceNativeModule';
import type {
  KScanVoiceCapabilities,
  KScanVoiceErrorCode,
  KScanVoiceFinalResult,
  KScanVoicePartialTranscriptEvent,
  KScanVoicePlatform,
  KScanVoiceSessionEndedEvent,
  KScanVoiceSessionEndedReason,
  KScanVoiceStartOptions,
} from './KScanVoiceNative.types';

export type {
  KScanVoiceCapabilities,
  KScanVoiceErrorCode,
  KScanVoiceFinalResult,
  KScanVoicePartialTranscriptEvent,
  KScanVoicePlatform,
  KScanVoiceSessionEndedEvent,
  KScanVoiceSessionEndedReason,
  KScanVoiceStartOptions,
};

export { KScanVoiceNativeModule };

export function getVoiceCapabilities(): Promise<KScanVoiceCapabilities> {
  return KScanVoiceNativeModule.getCapabilities();
}

export function requestVoicePermissions(): Promise<{ granted: boolean; canAskAgain: boolean }> {
  return KScanVoiceNativeModule.requestPermissions();
}

export function startVoiceListening(options: KScanVoiceStartOptions = {}): Promise<void> {
  return KScanVoiceNativeModule.startListening(options);
}

export function stopVoiceListening(): Promise<KScanVoiceFinalResult | null> {
  return KScanVoiceNativeModule.stopListening();
}

export function cancelVoiceListening(): Promise<void> {
  return KScanVoiceNativeModule.cancelListening();
}
