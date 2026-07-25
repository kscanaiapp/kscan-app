// Guarded, lazy access to the kscan-pii-native face-masking module.
//
// The native module throws at require time when the binary lacks it (older
// development clients, Expo Go, web). Every access goes through a lazy require
// inside try/catch so an absent native module degrades to a truthful
// "unsupported" capability instead of crashing the shared route graph.

import type {
  NativeCleanupResult,
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
} from '../../modules/kscan-pii-native/src/KScanPiiNative.types';

type NativeModuleShape = {
  getPrivacyCapabilities(): Promise<NativePrivacyCapabilities>;
  detectAndMaskFaces(input: NativeFaceMaskInput): Promise<NativeFaceMaskResult>;
  cleanupSanitizedImage(uri: string): Promise<NativeCleanupResult>;
};

let cachedModule: NativeModuleShape | null | undefined;

function loadNativeModule(): NativeModuleShape | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // Lazy require so requireNativeModule() executes here, inside the guard.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../modules/kscan-pii-native/src/KScanPiiNativeModule');
    cachedModule = (mod?.default ?? mod) as NativeModuleShape;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** True when the native face engine is present in this binary. */
export function isNativeFaceEngineLinked(): boolean {
  return loadNativeModule() !== null;
}

/**
 * Capabilities, or null when the native module is absent. Callers must treat
 * null exactly like supported === false (fail closed).
 */
export async function getFaceEngineCapabilities(): Promise<NativePrivacyCapabilities | null> {
  const mod = loadNativeModule();
  if (!mod) return null;
  try {
    return await mod.getPrivacyCapabilities();
  } catch {
    return null;
  }
}

/**
 * Run local face detection + irreversible masking. Returns null when the
 * native engine is absent — the caller must fail closed.
 */
export async function detectAndMaskFacesLocal(
  input: NativeFaceMaskInput,
): Promise<NativeFaceMaskResult | null> {
  const mod = loadNativeModule();
  if (!mod) return null;
  return mod.detectAndMaskFaces(input);
}

/** Best-effort native-side cleanup of a sanitized artifact. Never throws. */
export async function cleanupNativeSanitizedImage(uri: string): Promise<NativeCleanupResult | null> {
  const mod = loadNativeModule();
  if (!mod) return null;
  try {
    return await mod.cleanupSanitizedImage(uri);
  } catch {
    return null;
  }
}
