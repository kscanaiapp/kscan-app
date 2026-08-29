// Secure Android URI materialization for the privacy pipeline.
//
// content:// grants from the system photo picker, MediaStore, document
// providers, downloads, and cloud-photo providers are temporary. This adapter
// copies the source into the app-private privacy cache while the grant is
// valid and returns an owned file:// URI the native module can process. The
// materialized original is removed by the caller (in `finally`) as soon as
// processing completes. No persistent URI permission and no persistent
// filesystem path is required.

import * as FileSystem from 'expo-file-system/legacy';
import {
  createArtifactPath,
  deletePrivacyArtifact,
  ensurePrivacyArtifactDir,
} from './privacyArtifactStore';

export const MATERIALIZE_MAX_BYTES_DEFAULT = 25 * 1024 * 1024; // 25 MB pre-processing cap

export type MaterializeErrorCode =
  | 'UNSUPPORTED_SCHEME'
  | 'ACCESS_EXPIRED_OR_DENIED'
  | 'COPY_FAILED'
  | 'EMPTY_SOURCE'
  | 'SOURCE_TOO_LARGE';

export class MaterializeError extends Error {
  code: MaterializeErrorCode;

  constructor(code: MaterializeErrorCode, message: string) {
    super(message);
    this.name = 'MaterializeError';
    this.code = code;
  }
}

export interface MaterializedImage {
  /** Owned file:// URI inside the privacy cache namespace. */
  uri: string;
  sizeBytes: number;
}

function extensionForUri(uri: string): string {
  const match = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(uri);
  return match ? match[1].toLowerCase() : 'img';
}

function isSupportedScheme(uri: string): boolean {
  return uri.startsWith('content://') || uri.startsWith('file://');
}

/**
 * Copy a picker/camera image into the app-private privacy cache.
 *
 * Throws MaterializeError on every failure; on failure no partial copy is
 * left behind. The returned URI is owned by the privacy artifact store and
 * must be deleted by the caller after processing.
 */
export async function materializeImageForPrivacy(
  sourceUri: string,
  options?: { maxBytes?: number },
): Promise<MaterializedImage> {
  if (!sourceUri || typeof sourceUri !== 'string' || !isSupportedScheme(sourceUri)) {
    throw new MaterializeError(
      'UNSUPPORTED_SCHEME',
      'Only content:// and file:// image sources are supported.',
    );
  }

  const maxBytes = options?.maxBytes ?? MATERIALIZE_MAX_BYTES_DEFAULT;
  await ensurePrivacyArtifactDir();
  const destination = createArtifactPath('original', extensionForUri(sourceUri));

  try {
    await FileSystem.copyAsync({ from: sourceUri, to: destination });
  } catch (err) {
    // A failed copy of a content:// URI is indistinguishable from an expired
    // or revoked temporary grant at this layer; both are terminal and must
    // fail closed with a recoverable message.
    await deletePrivacyArtifact(destination);
    const message = err instanceof Error ? err.message : String(err);
    if (sourceUri.startsWith('content://')) {
      throw new MaterializeError(
        'ACCESS_EXPIRED_OR_DENIED',
        `Could not read the selected image. The access grant may have expired — please reselect the image. (${message})`,
      );
    }
    throw new MaterializeError('COPY_FAILED', `Could not copy the selected image: ${message}`);
  }

  let sizeBytes = 0;
  try {
    const info = await FileSystem.getInfoAsync(destination);
    if (!info.exists) {
      throw new MaterializeError('COPY_FAILED', 'Materialized copy is missing after copy.');
    }
    sizeBytes = typeof (info as { size?: number }).size === 'number' ? (info as { size: number }).size : 0;
  } catch (err) {
    await deletePrivacyArtifact(destination);
    if (err instanceof MaterializeError) throw err;
    throw new MaterializeError('COPY_FAILED', 'Could not verify the materialized copy.');
  }

  if (sizeBytes <= 0) {
    await deletePrivacyArtifact(destination);
    throw new MaterializeError('EMPTY_SOURCE', 'The selected image is empty or unreadable.');
  }

  if (sizeBytes > maxBytes) {
    await deletePrivacyArtifact(destination);
    throw new MaterializeError(
      'SOURCE_TOO_LARGE',
      'The selected image is too large to process privately on this device.',
    );
  }

  return { uri: destination, sizeBytes };
}
