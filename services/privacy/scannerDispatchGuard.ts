import type { PrivacyProof } from './privacyProof';

// Private session binding: serialized/copied proofs cannot authorize another
// image. Weak keys release the binding when the session releases its proof.
const preparedImages = new WeakMap<PrivacyProof, string>();

/** Internal producer seam: called only after the real local pipeline succeeds. */
export function registerScannerImageForDispatch(image: string, proof: PrivacyProof): void {
  Object.freeze(proof);
  preparedImages.set(proof, image.replace(/^data:image\/jpeg;base64,/, ''));
}

export function assertScannerImageReadyForDispatch(image: string, proof: PrivacyProof | null | undefined): boolean {
  if (!proof || !proof.processingCompleted || !proof.outputVerified || !proof.metadataStripped ||
      !proof.faceDetectionPerformed || !proof.plateDetectionPerformed || typeof image !== 'string') return false;
  const expected = preparedImages.get(proof);
  return expected !== undefined && image.replace(/^data:image\/jpeg;base64,/, '') === expected;
}
