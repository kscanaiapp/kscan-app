// Scanner adapter over the existing shared local privacy boundary. Never accepts
// a caller's "already sanitized" assertion, image bytes, or a remote URL.
import { prepareImageForDispatch, PrivacyDispatchBlockedError } from './privacyBoundary';
import type { PrivacyProof } from './privacyProof';
import { compressSanitizedImageForAnalysis, cleanupSanitizedImage } from '../privacyImageUpload';
import { registerScannerImageForDispatch } from './scannerDispatchGuard';

export type PreparedPrivateScannerImage = {
  imageBase64: string;
  width: number;
  height: number;
  proof: PrivacyProof;
};

/** Every image, including a locally derived crop, receives its own privacy run. */
export async function prepareScannerImageForDispatch(
  localUri: string,
  options: { maxDimension?: number; quality?: number; signal?: { aborted: boolean } } = {},
): Promise<PreparedPrivateScannerImage> {
  if (typeof localUri !== 'string' || !/^(file|content):\/\//.test(localUri)) {
    throw new PrivacyDispatchBlockedError('SOURCE_ACCESS_FAILED');
  }
  const maxDimension = options.maxDimension ?? 1536;
  const quality = options.quality ?? 0.85;
  if (!Number.isSafeInteger(maxDimension) || maxDimension < 1 || maxDimension > 4096 ||
      !Number.isFinite(quality) || quality <= 0 || quality > 1 || options.signal?.aborted) {
    throw new PrivacyDispatchBlockedError('VERIFICATION_FAILED');
  }
  const boundary = await prepareImageForDispatch(localUri, { platePolicy: 'mask' });
  if (boundary.status === 'BLOCKED') {
    throw new PrivacyDispatchBlockedError(boundary.errorCode, boundary.userMessage);
  }
  let encodedUri: string | undefined;
  try {
    const { proof, width, height } = boundary;
    if (!proof.processingCompleted || !proof.outputVerified || !proof.metadataStripped ||
        !proof.faceDetectionPerformed || !proof.plateDetectionPerformed ||
        !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        !width || !height || options.signal?.aborted) {
      throw new PrivacyDispatchBlockedError('VERIFICATION_FAILED');
    }
    // This existing encoder reads ONLY the verified local artifact, strips
    // metadata through re-encoding, and bounds the longest edge without upscaling.
    const encoded = await compressSanitizedImageForAnalysis(boundary.sanitizedUri, {
      width: maxDimension, quality, sourceWidth: width, sourceHeight: height,
    });
    encodedUri = encoded.uri;
    if (!encodedUri || encodedUri === localUri || encodedUri === boundary.sanitizedUri ||
        !encodedUri.startsWith('file://') ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(encoded.base64) ||
        encoded.base64.length > 8 * 1024 * 1024 || options.signal?.aborted) {
      throw new PrivacyDispatchBlockedError('VERIFICATION_FAILED');
    }
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const privateProof = { ...proof };
    registerScannerImageForDispatch(encoded.base64, privateProof);
    return {
      imageBase64: encoded.base64,
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      proof: privateProof,
    };
  } catch {
    throw new PrivacyDispatchBlockedError('VERIFICATION_FAILED');
  } finally {
    // Never delete an input if an old/invalid encoder returned it as output.
    if (encodedUri && encodedUri !== localUri && encodedUri !== boundary.sanitizedUri) {
      await cleanupSanitizedImage(encodedUri);
    }
    await boundary.cleanup();
  }
}
