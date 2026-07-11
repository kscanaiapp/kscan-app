import { requireNativeModule } from 'expo-modules-core';
import type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
} from './KScanPiiNative.types';

interface KScanPiiNativeModuleType {
  getPrivacyCapabilities(): Promise<NativePrivacyCapabilities>;
  detectAndMaskFaces(input: NativeFaceMaskInput): Promise<NativeFaceMaskResult>;
  cleanupSanitizedImage(uri: string): Promise<NativeCleanupResult>;
}

const KScanPiiNativeModule = requireNativeModule<KScanPiiNativeModuleType>('KScanPiiNative');

export default KScanPiiNativeModule;
