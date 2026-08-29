/**
 * Web has no on-device-only speech recognition guarantee available through
 * this module, so it always reports unavailable rather than falling back to
 * a browser/cloud recognizer. Voice Scan is not a supported surface on web
 * in V1; this stub exists only so importing the module never crashes a web
 * bundle.
 */
import type {
  KScanVoiceCapabilities,
  KScanVoiceFinalResult,
  KScanVoiceStartOptions,
} from './KScanVoiceNative.types';

function unsupportedCapabilities(): KScanVoiceCapabilities {
  return { supported: false, onDeviceAvailable: false, platform: 'web' };
}

export default {
  getCapabilities(): Promise<KScanVoiceCapabilities> {
    return Promise.resolve(unsupportedCapabilities());
  },
  requestPermissions(): Promise<{ granted: boolean; canAskAgain: boolean }> {
    return Promise.resolve({ granted: false, canAskAgain: false });
  },
  startListening(_options: KScanVoiceStartOptions): Promise<void> {
    return Promise.reject(new Error('ON_DEVICE_RECOGNITION_UNAVAILABLE'));
  },
  stopListening(): Promise<KScanVoiceFinalResult | null> {
    return Promise.resolve(null);
  },
  cancelListening(): Promise<void> {
    return Promise.resolve();
  },
  addListener() {
    return { remove() {} };
  },
  removeAllListeners() {},
};
