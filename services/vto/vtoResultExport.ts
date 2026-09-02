/**
 * The explicit bridge from a session-scoped try-on result to a file the
 * Dressing Room save flow can actually accept.
 *
 * WHY IT IS NEEDED AT ALL. A VTO result is a `data:` URI held in memory for
 * the session (types/vto.ts: "never written to the Closet, a gallery, or any
 * durable store by this foundation"). The Dressing Room image contract
 * (services/dressingRoomItemContract.ts) accepts only file/content/asset/ph
 * URIs, storage references, or public https URLs -- a `data:` URI resolves to
 * `kind: 'none'` and the save is refused. So a save requires materializing
 * the bytes to a real cache file first.
 *
 * WHY THAT DOES NOT WEAKEN THE PRIVACY RULE. Nothing here runs unless the
 * user taps "Save to Dressing Room". There is no auto-save: closing the sheet
 * without tapping it leaves the result exactly as ephemeral as before, and
 * `discardVtoResultExport` removes the file if the save is abandoned. The
 * durable copy is created by an explicit user act, which is precisely the
 * boundary the foundation asked for.
 *
 * The person photo is never exported here. Only the generated visualization.
 */

import * as FileSystem from 'expo-file-system/legacy';

const EXPORT_DIRECTORY_NAME = 'kscan-vto-export/';
const EXPORT_FILE_PREFIX = 'vto-';

/** Only still-image types a try-on may legitimately produce. */
const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type VtoExportErrorCode =
  | 'unsupported_result'
  | 'cache_unavailable'
  | 'write_failed';

export class VtoExportError extends Error {
  code: VtoExportErrorCode;

  constructor(code: VtoExportErrorCode, message: string) {
    super(message);
    this.name = 'VtoExportError';
    this.code = code;
  }
}

export interface ParsedVtoDataUri {
  mediaType: string;
  base64: string;
  extension: string;
}

/**
 * Parses a base64 `data:` URI into its media type and payload.
 *
 * Deliberately strict: only base64-encoded still images we recognise are
 * accepted, so a malformed or unexpected result surfaces as a refusal here
 * rather than as a corrupt file in someone's Dressing Room.
 */
export function parseVtoResultDataUri(dataUri: unknown): ParsedVtoDataUri | null {
  if (typeof dataUri !== 'string') return null;
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUri.trim());
  if (!match) return null;

  const mediaType = match[1].toLowerCase();
  const extension = EXTENSION_BY_MEDIA_TYPE[mediaType];
  if (!extension) return null;

  const base64 = match[2].replace(/\s+/g, '');
  if (!base64) return null;

  return { mediaType, base64, extension };
}

function exportDirectory(fs: FileSystemLike): string {
  const base = fs.cacheDirectory;
  if (!base) {
    throw new VtoExportError('cache_unavailable', 'The application cache is unavailable.');
  }
  return `${base}${EXPORT_DIRECTORY_NAME}`;
}

/** The slice of expo-file-system this module uses; injectable for tests. */
export interface FileSystemLike {
  cacheDirectory: string | null;
  makeDirectoryAsync: (uri: string, options?: { intermediates?: boolean }) => Promise<void>;
  writeAsStringAsync: (uri: string, contents: string, options?: { encoding?: string }) => Promise<void>;
  getInfoAsync: (uri: string) => Promise<{ exists: boolean; isDirectory?: boolean; size?: number }>;
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
  EncodingType: { Base64: string };
}

export interface VtoExportedResult {
  /** `file://` URI inside the app cache, suitable for the Dressing Room save. */
  localUri: string;
  mediaType: string;
  sizeBytes: number;
}

/**
 * Writes a try-on result to an app-cache file and returns its `file://` URI.
 *
 * Fails closed: any write that produces a missing or empty file is deleted and
 * reported as an error rather than handed onward as a usable image.
 */
export async function exportVtoResultToCache(
  input: { dataUri: unknown; requestId?: string | null },
  deps?: { fileSystem?: FileSystemLike; now?: () => number },
): Promise<VtoExportedResult> {
  const fs = (deps?.fileSystem ?? (FileSystem as unknown)) as FileSystemLike;
  const now = deps?.now ?? Date.now;

  const parsed = parseVtoResultDataUri(input.dataUri);
  if (!parsed) {
    throw new VtoExportError(
      'unsupported_result',
      'This try-on result cannot be saved.',
    );
  }

  const directory = exportDirectory(fs);
  await fs.makeDirectoryAsync(directory, { intermediates: true });

  // The request id keeps two saves from the same session apart; the timestamp
  // keeps a retry of the SAME request from colliding with its predecessor.
  const safeRequestId = String(input.requestId ?? 'result').replace(/[^A-Za-z0-9_-]/g, '');
  const target = `${directory}${EXPORT_FILE_PREFIX}${safeRequestId || 'result'}-${now()}.${parsed.extension}`;

  try {
    await fs.writeAsStringAsync(target, parsed.base64, {
      encoding: fs.EncodingType.Base64,
    });
    const info = await fs.getInfoAsync(target);
    const size = typeof info.size === 'number' ? info.size : 0;
    if (!info.exists || info.isDirectory || size <= 0) {
      throw new VtoExportError('write_failed', 'The try-on image could not be prepared.');
    }
    return { localUri: target, mediaType: parsed.mediaType, sizeBytes: size };
  } catch (error) {
    await discardVtoResultExport(target, { fileSystem: fs });
    if (error instanceof VtoExportError) throw error;
    throw new VtoExportError('write_failed', 'The try-on image could not be prepared.');
  }
}

/**
 * Removes an exported file. Called when the user closes the save flow without
 * completing it, so an abandoned save leaves nothing behind.
 */
export async function discardVtoResultExport(
  localUri: string | null | undefined,
  deps?: { fileSystem?: FileSystemLike },
): Promise<void> {
  if (!localUri) return;
  const fs = (deps?.fileSystem ?? (FileSystem as unknown)) as FileSystemLike;
  try {
    await fs.deleteAsync(localUri, { idempotent: true });
  } catch {
    // Best effort: an undeleted cache file is not worth failing a user action.
  }
}
