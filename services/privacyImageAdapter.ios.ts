/**
 * iOS privacy image adapter (passthrough posture).
 *
 * Exports a valid matching implementation so the iOS JavaScript bundle
 * compiles, performs no work at module-import time, and fails closed: no
 * masking is ever claimed while no approved iOS privacy capability exists.
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
