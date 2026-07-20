/**
 * Cross-platform privacy image adapter contract.
 *
 * Both platform implementations (privacyImageAdapter.android.ts and
 * privacyImageAdapter.ios.ts) must export the same function name, argument
 * shape, asynchronous return type, result shape, and error model. Shared
 * Scanner code depends only on this contract and must never import a
 * platform-only native module directly.
 *
 * QA/truthful posture: while no on-device masking capability is approved,
 * both implementations run in `passthrough` mode and MUST report
 * `localPrivacyFiltered: false` with no `privacyProof`. Claiming filtering
 * that did not occur is prohibited (production privacy release gate).
 */

export type PrivacyAdapterMode = 'passthrough';

export type PrivacyAdaptedImage = {
  /** URI (or base64 payload reference) of the image to upload. */
  uri: string;
  /** Adapter mode actually applied to this image. */
  mode: PrivacyAdapterMode;
  /**
   * True only when a real local privacy filter (face/plate masking) ran on
   * this image. Passthrough mode always reports false.
   */
  localPrivacyFiltered: boolean;
  /** Present only when a verifiable local masking proof exists. */
  privacyProof?: undefined;
};

export type PreparePrivacyAdaptedImage = (
  imageUri: string,
) => Promise<PrivacyAdaptedImage>;

export class PrivacyAdapterInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyAdapterInputError';
  }
}

/**
 * Shared passthrough implementation. Platform modules re-export this until an
 * approved on-device masking capability exists for that platform. It fails
 * closed: no masking is ever claimed, and invalid input rejects instead of
 * silently uploading an unexpected payload.
 */
export async function passthroughPrepare(
  imageUri: string,
): Promise<PrivacyAdaptedImage> {
  if (typeof imageUri !== 'string' || imageUri.length === 0) {
    throw new PrivacyAdapterInputError('privacy adapter received an invalid image reference');
  }
  return {
    uri: imageUri,
    mode: 'passthrough',
    localPrivacyFiltered: false,
  };
}
