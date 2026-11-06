import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Device-local SCANNER choices, not Android/iOS permission grants.
 * OFF prevents Scanner capture / opening the Scanner photo picker. ON only
 * permits the feature to ask the OS at the point of use. This must never be
 * described as revoking an operating-system permission.
 *
 * Missing storage means a pre-upgrade install: keep existing Scanner access.
 * Malformed/unreadable persisted state fails closed at its callers rather than
 * silently replacing an explicit OFF with ON.
 */
export const SCANNER_MEDIA_CHOICES_KEY = '@kscan/scanner-media-choices/v1';

export type ScannerMediaChoice = 'camera' | 'photos';

export interface ScannerMediaChoices {
  camera: boolean;
  photos: boolean;
}

export const DEFAULT_SCANNER_MEDIA_CHOICES: Readonly<ScannerMediaChoices> = Object.freeze({
  camera: true,
  photos: true,
});

let writeQueue: Promise<unknown> = Promise.resolve();

export async function readScannerMediaChoices(): Promise<ScannerMediaChoices> {
  const saved = await AsyncStorage.getItem(SCANNER_MEDIA_CHOICES_KEY);
  if (saved === null) return { ...DEFAULT_SCANNER_MEDIA_CHOICES };
  const parsed: unknown = JSON.parse(saved);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Scanner media choices are unreadable');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.camera !== 'boolean' || typeof record.photos !== 'boolean') {
    throw new Error('Scanner media choices have invalid values');
  }
  return { camera: record.camera, photos: record.photos };
}

/** Serialize changes so two fast switches cannot overwrite one another. */
export function saveScannerMediaChoice(
  key: ScannerMediaChoice,
  enabled: boolean,
): Promise<ScannerMediaChoices> {
  if ((key !== 'camera' && key !== 'photos') || typeof enabled !== 'boolean') {
    return Promise.reject(new Error('Invalid Scanner media choice'));
  }
  const task = writeQueue.then(async () => {
    const before = await readScannerMediaChoices();
    const next = { ...before, [key]: enabled };
    await AsyncStorage.setItem(SCANNER_MEDIA_CHOICES_KEY, JSON.stringify(next));
    return next;
  });
  writeQueue = task.then(() => undefined, () => undefined);
  return task;
}
