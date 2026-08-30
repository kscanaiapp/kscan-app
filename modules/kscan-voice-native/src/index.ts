import KScanVoiceNativeModule from './KScanVoiceNativeModule';
import type {
  KScanVoiceCapabilities,
  KScanVoiceErrorCode,
  KScanVoiceFinalResult,
  KScanVoicePartialTranscriptEvent,
  KScanVoicePlatform,
  KScanVoiceSessionEndedEvent,
  KScanVoiceSessionEndedReason,
  KScanVoiceSessionOptions,
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
  KScanVoiceSessionOptions,
  KScanVoiceStartOptions,
};

export { KScanVoiceNativeModule };

export function getVoiceCapabilities(): Promise<KScanVoiceCapabilities> {
  return KScanVoiceNativeModule.getCapabilities();
}

export function requestVoicePermissions(): Promise<{ granted: boolean; canAskAgain: boolean }> {
  return KScanVoiceNativeModule.requestPermissions();
}

export function startVoiceListening(options: KScanVoiceStartOptions): Promise<void> {
  return KScanVoiceNativeModule.startListening(options);
}

export function stopVoiceListening(options: KScanVoiceSessionOptions): Promise<KScanVoiceFinalResult | null> {
  return KScanVoiceNativeModule.stopListening(options);
}

export function cancelVoiceListening(options: KScanVoiceSessionOptions): Promise<void> {
  return KScanVoiceNativeModule.cancelListening(options);
}
