// services/imageUtils.js
import * as ImageManipulator from 'expo-image-manipulator';

function logCompressDiag(payload) {
  console.log(`[KSCAN_DIAG_COMPRESS] ${JSON.stringify({
    ...payload,
    timestamp: Date.now(),
  })}`);
}

/**
 * Resize and compress a photo for upload.
 * Target: <= 896px wide, JPEG at 0.65 quality, base64-encoded.
 * Typical output: 120-320 KB, well under the server limit.
 *
 * Returns a data URI string: "data:image/jpeg;base64,..."
 * Throws a user-readable Error on failure.
 */
export async function compressForUpload(uri) {
  if (!uri || typeof uri !== 'string') {
    throw new Error('No image to process. Please take a photo first.');
  }

  if (__DEV__) {
    console.log('[DEBUG] COMPRESSION_START uri=' + uri.slice(0, 80));
    console.log('[DEBUG] COMPRESSION_SETTINGS maxWidth=896 quality=0.65 format=JPEG base64=true');
  }
  const t0 = Date.now();

  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 896 } }],
      { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );

    if (!result.base64) {
      throw new Error('Compression produced no output.');
    }

    const dataUri = `data:image/jpeg;base64,${result.base64}`;
    logCompressDiag({
      event: 'compression_complete',
      compressionElapsedMs: Date.now() - t0,
      compressedBase64Length: typeof result?.base64 === 'string' ? result.base64.length : 0,
      dataUriLength: typeof dataUri === 'string' ? dataUri.length : 0,
      hasExpectedDataUriPrefix:
        typeof dataUri === 'string' && dataUri.startsWith('data:image/jpeg;base64,'),
    });

    if (__DEV__) {
      console.log(
        '[DEBUG] COMPRESSION_DONE duration=' + (Date.now() - t0) + 'ms' +
        ' outputUri=' + (result.uri ?? '').slice(0, 60) +
        ' base64Len=' + result.base64.length
      );
    }

    return dataUri;
  } catch (error) {
    logCompressDiag({
      event: 'compression_error',
      compressionElapsedMs: Date.now() - t0,
      errorName: error?.name ?? null,
      errorMessage: error?.message ?? null,
    });
    if (__DEV__) console.error('[DEBUG] COMPRESSION_ERROR duration=' + (Date.now() - t0) + 'ms', error?.message);
    if (error.message && !error.message.includes('manipulate')) {
      throw error;
    }
    throw new Error('Could not prepare the image. Please try again.');
  }
}
