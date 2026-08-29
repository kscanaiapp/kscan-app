// Guarded, lazy access to the kscan-pii-native license-plate screening module.
//
// Deliberately a twin of ./nativeFaceEngine.ts rather than an extension of it:
// the two capabilities are claimed independently downstream, and a build that
// links one but not the other must be able to say so truthfully instead of
// collapsing both into a single boolean.
//
// The native module throws at require time when the binary lacks it (older
// development clients, Expo Go, web, and every Node test run). Every access
// goes through a lazy require inside try/catch so an absent native module
// degrades to a truthful "unsupported" capability instead of crashing — and,
// critically, never degrades to "use the original image".

import type {
  NativePlateCapabilities,
  NativePlateMaskInput,
  NativePlateMaskResult,
} from '../../modules/kscan-pii-native/src/KScanPiiNative.types';

type NativePlateModuleShape = {
  getPlateCapabilities(): Promise<NativePlateCapabilities>;
  detectAndMaskPlates(input: NativePlateMaskInput): Promise<NativePlateMaskResult>;
};

let cachedModule: NativePlateModuleShape | null | undefined;

function loadNativeModule(): NativePlateModuleShape | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // Lazy require so requireNativeModule() executes here, inside the guard.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../modules/kscan-pii-native/src/KScanPiiNativeModule');
    const resolved = (mod?.default ?? mod) as Partial<NativePlateModuleShape>;
    // Presence of the module is not presence of THIS capability: an older
    // binary can link a face-only build of the same module. Require both
    // functions before claiming plate support.
    cachedModule =
      typeof resolved?.detectAndMaskPlates === 'function' &&
      typeof resolved?.getPlateCapabilities === 'function'
        ? (resolved as NativePlateModuleShape)
        : null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** True only when this binary links a plate-capable build of the engine. */
export function isNativePlateEngineLinked(): boolean {
  return loadNativeModule() !== null;
}

/**
 * Capabilities, or null when the capability is absent. Callers must treat null
 * exactly like supported === false (fail closed).
 */
export async function getPlateEngineCapabilities(): Promise<NativePlateCapabilities | null> {
  const mod = loadNativeModule();
  if (!mod) return null;
  try {
    return await mod.getPlateCapabilities();
  } catch {
    return null;
  }
}

/**
 * Run local plate-region screening + irreversible masking over an image that
 * has ALREADY been face-sanitized. Returns null when the capability is absent —
 * the caller must fail closed.
 */
export async function detectAndMaskPlatesLocal(
  input: NativePlateMaskInput,
): Promise<NativePlateMaskResult | null> {
  const mod = loadNativeModule();
  if (!mod) return null;
  try {
    return await mod.detectAndMaskPlates(input);
  } catch {
    // A throwing native call is a failed run, never an absent one: returning
    // null here would be indistinguishable from "not linked". Callers block on
    // either, but the distinction matters for the reported reason.
    return {
      status: 'failed',
      platform: 'android',
      detectorImplementation: 'unavailable',
      detectorVersion: 'unknown',
      sanitizerVersion: 'unknown',
      platesDetected: 0,
      platesAccepted: 0,
      platesMasked: 0,
      regionsChanged: 0,
      regionsAlreadyRedacted: 0,
      pixelsChanged: false,
      ocrPerformed: false,
      warnings: ['Native plate screening threw.'],
      errorCode: 'INTERNAL_ERROR',
      failureReason: 'Native plate screening threw.',
    };
  }
}

/** Test seam only. Resets the memoized module handle. */
export function __resetNativePlateEngineCache(): void {
  cachedModule = undefined;
}
