import { requireNativeModule } from 'expo-modules-core';
import type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
  NativeExtractionCapabilities,
  NativePersonDetectionInput,
  NativePersonDetectionResult,
} from './KScanPiiNative.types';

interface KScanPiiNativeModuleType {
  getPrivacyCapabilities(): Promise<NativePrivacyCapabilities>;
  detectAndMaskFaces(input: NativeFaceMaskInput): Promise<NativeFaceMaskResult>;
  cleanupSanitizedImage(uri: string): Promise<NativeCleanupResult>;
  // Build 2.5 Step 3. Read-only geometry: writes nothing, modifies nothing.
  getExtractionCapabilities(): Promise<NativeExtractionCapabilities>;
  detectPersonRegions(input: NativePersonDetectionInput): Promise<NativePersonDetectionResult>;
}

const KScanPiiNativeModule = requireNativeModule<KScanPiiNativeModuleType>('KScanPiiNative');

export default KScanPiiNativeModule;
