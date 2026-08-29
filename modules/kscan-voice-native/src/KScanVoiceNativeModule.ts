import { NativeModule, requireNativeModule } from 'expo-modules-core';
import type {
  KScanVoiceCapabilities,
  KScanVoiceFinalResult,
  KScanVoicePartialTranscriptEvent,
  KScanVoiceSessionEndedEvent,
  KScanVoiceStartOptions,
} from './KScanVoiceNative.types';

interface KScanVoiceNativeEvents {
  onPartialTranscript: (event: KScanVoicePartialTranscriptEvent) => void;
  onSessionEnded: (event: KScanVoiceSessionEndedEvent) => void;
  [key: string]: (...args: any[]) => void;
}

declare class KScanVoiceNativeModuleClass extends NativeModule<KScanVoiceNativeEvents> {
  getCapabilities(): Promise<KScanVoiceCapabilities>;
  requestPermissions(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  startListening(options: KScanVoiceStartOptions): Promise<void>;
  stopListening(): Promise<KScanVoiceFinalResult | null>;
  cancelListening(): Promise<void>;
}

const KScanVoiceNativeModule = requireNativeModule<KScanVoiceNativeModuleClass>('KScanVoiceNative');

export default KScanVoiceNativeModule;
