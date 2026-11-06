import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Device-local, Scanner-specific choice. This is NOT the Android/iOS runtime
 * permission grant: Camera permission is still requested on first camera use,
 * and Photos uses the system photo picker with a per-selection choice.
 *
 * OFF must be enforced before opening Scanner's camera or photo picker.
 * Defaults ON so previously installed clients retain the existing
 * point-of-use behavior until the user expressly turns a switch off.
 */
export type ScannerMediaPreference = 'camera' | 'photos';

export const SCANNER_MEDIA_DEFAULTS: Readonly<Record<ScannerMediaPreference, boolean>> =
  Object.freeze({ camera: true, photos: true });

const STORAGE_KEYS: Record<ScannerMediaPreference, string> = {
  camera: '@kscan/scanner-camera-choice-v1',
  photos: '@kscan/scanner-photo-choice-v1',
};

export async function readScannerMediaPreference(key: ScannerMediaPreference): Promise<boolean> {
  const value = await AsyncStorage.getItem(STORAGE_KEYS[key]);
  // A storage error throws: do not misrepresent an unreadable OFF as ON.
  // Unknown values also fail closed rather than granting access.
  return value === null ? SCANNER_MEDIA_DEFAULTS[key] : value === 'on';
}

export async function writeScannerMediaPreference(
  key: ScannerMediaPreference,
  enabled: boolean,
): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS[key], enabled ? 'on' : 'off');
}
