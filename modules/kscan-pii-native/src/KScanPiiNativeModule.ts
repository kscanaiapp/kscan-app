import { requireNativeModule } from 'expo-modules-core';
import type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
  NativeExtractionCapabilities,
  NativePersonDetectionInput,
  NativePersonDetectionResult,
  NativePlateCapabilities,
  NativePlateMaskInput,
  NativePlateMaskResult,
} from './KScanPiiNative.types';

interface KScanPiiNativeModuleType {
  getPrivacyCapabilities(): Promise<NativePrivacyCapabilities>;
  detectAndMaskFaces(input: NativeFaceMaskInput): Promise<NativeFaceMaskResult>;
  cleanupSanitizedImage(uri: string): Promise<NativeCleanupResult>;
  // Build 34 Track B B2A. Region-geometry plate screening + masking; performs
  // no character recognition on any path.
  getPlateCapabilities(): Promise<NativePlateCapabilities>;
  detectAndMaskPlates(input: NativePlateMaskInput): Promise<NativePlateMaskResult>;
  // Build 2.5 Step 3. Read-only geometry: writes nothing, modifies nothing.
  getExtractionCapabilities(): Promise<NativeExtractionCapabilities>;
  detectPersonRegions(input: NativePersonDetectionInput): Promise<NativePersonDetectionResult>;
}

const KScanPiiNativeModule = requireNativeModule<KScanPiiNativeModuleType>('KScanPiiNative');

export default KScanPiiNativeModule;
