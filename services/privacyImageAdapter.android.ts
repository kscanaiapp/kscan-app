/**
 * Android privacy image adapter (passthrough posture).
 *
 * No Android-only native module is imported here. When an approved on-device
 * masking capability lands, this file may import Android-specific modules —
 * shared code must keep importing `./privacyImageAdapter` so Metro resolves
 * the platform file, and the exported contract must not change.
 */
import {
  passthroughPrepare,
  type PrivacyAdaptedImage,
} from './privacyImageAdapter.types';

export async function preparePrivacyAdaptedImage(
  imageUri: string,
): Promise<PrivacyAdaptedImage> {
  return passthroughPrepare(imageUri);
}
