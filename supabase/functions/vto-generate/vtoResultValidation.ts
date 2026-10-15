/**
 * Result validation seam.
 *
 * "The provider returned 200" is not "K Scan has something worth showing a
 * person." This is the boundary between those two claims.
 *
 * Alpha validates only what can be checked honestly and cheaply: the media
 * type is one we accept, the payload is a real data URI, the base64 decodes,
 * the decoded bytes are a plausible size, and the magic bytes agree with the
 * declared type. It deliberately does NOT pretend to judge identity fidelity,
 * garment fidelity, body integrity, or visual corruption -- inventing an
 * unreliable quality classifier would be worse than admitting we have none.
 * Those checks belong here later; the seam is what this phase owes them.
 */

import {
  VTO_ALLOWED_MEDIA_TYPES,
  VTO_RESULT_MAX_BYTES,
  VTO_RESULT_MIN_BYTES,
  type VtoProviderMedia,
} from './vtoContract.ts';

const DATA_URI_PATTERN = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

const MAGIC_BYTES: Readonly<Record<string, readonly number[]>> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  // RIFF....WEBP -- only the RIFF prefix is fixed at offset 0.
  'image/webp': [0x52, 0x49, 0x46, 0x46],
};

export type VtoResultValidation =
  | { ok: true; media: VtoProviderMedia; byteLength: number }
  | { ok: false; reason: 'invalid_output'; detail: string };

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}


/**
 * VTO-005: parse actual encoded image dimensions instead of trusting vendor
 * metadata or header bytes alone. Structural integrity is not human fidelity.
 * Reject truncated formats and decompression-bomb declared dimensions.
 */
export function readVtoImageDimensions(
  bytes: Uint8Array, mediaType: string,
): { width: number; height: number } | null {
  const u16 = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  const u32 = (i: number) => (
    (bytes[i] * 16777216) + (bytes[i+1] << 16) + (bytes[i+2] << 8) + bytes[i+3]
  );
  let width = 0, height = 0;
  if (mediaType === 'image/png') {
    if (bytes.length < 45 || u32(8) !== 13 ||
      String.fromCharCode(...bytes.subarray(12,16)) !== 'IHDR' ||
      bytes[24] !== 8 || ![0,2,3,4,6].includes(bytes[25]) ||
      bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return null;
    width = u32(16); height = u32(20);
    // Require a complete IEND rather than a plausible 8-byte prefix.
    const n = bytes.length;
    if (String.fromCharCode(...bytes.subarray(n-8,n-4)) !== 'IEND') return null;
  } else if (mediaType === 'image/jpeg') {
    if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 ||
      bytes[bytes.length-2] !== 255 || bytes[bytes.length-1] !== 217) return null;
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 255) return null;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 0xda || marker === 0xd9) break;
      if ([0x01,0xd0,0xd1,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8].includes(marker)) continue;
      if (i+2 > bytes.length) return null;
      const length = u16(i);
      if (length < 2 || i + length > bytes.length) return null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
        if (length < 7) return null;
        height=u16(i+3); width=u16(i+5); break;
      }
      i += length;
    }
  } else if (mediaType === 'image/webp') {
    if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(8,12)) !== 'WEBP')
      return null;
    const riffSize = bytes[4] + bytes[5]*256 + bytes[6]*65536 + bytes[7]*16777216;
    if (riffSize + 8 > bytes.length) return null;
    const mode=String.fromCharCode(...bytes.subarray(12,16));
    if (mode === 'VP8X') {
      width = 1 + bytes[24] + bytes[25]*256 + bytes[26]*65536;
      height = 1 + bytes[27] + bytes[28]*256 + bytes[29]*65536;
    } else if (mode === 'VP8L') {
      if (bytes[20] !== 0x2f || bytes.length < 25) return null;
      width = 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]);
      height = 1 + (((bytes[24] & 0xf) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6));
    } else if (mode === 'VP8 ') {
      if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
        return null;
      width = (bytes[26] | (bytes[27]<<8)) & 0x3fff;
      height = (bytes[28] | (bytes[29]<<8)) & 0x3fff;
    } else return null;
  } else return null;

  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 4096 || height > 4096 ||
      width * height > 4096 * 4096) return null;
  return { width, height };
}

export function validateVtoResultMedia(media: VtoProviderMedia): VtoResultValidation {
  if (!media || typeof media.dataUri !== 'string') {
    return { ok: false, reason: 'invalid_output', detail: 'missing_data_uri' };
  }
  if (!(VTO_ALLOWED_MEDIA_TYPES as readonly string[]).includes(media.mediaType)) {
    return { ok: false, reason: 'invalid_output', detail: 'unsupported_media_type' };
  }
  const match = DATA_URI_PATTERN.exec(media.dataUri);
  if (!match) {
    return { ok: false, reason: 'invalid_output', detail: 'malformed_data_uri' };
  }
  if (match[1] !== media.mediaType) {
    // A declared type that disagrees with the payload's own header is exactly
    // the kind of "successful" response that renders as a broken image.
    return { ok: false, reason: 'invalid_output', detail: 'media_type_mismatch' };
  }
  const bytes = decodeBase64(match[2]);
  if (!bytes) {
    return { ok: false, reason: 'invalid_output', detail: 'base64_decode_failed' };
  }
  if (bytes.byteLength < VTO_RESULT_MIN_BYTES) {
    return { ok: false, reason: 'invalid_output', detail: 'result_too_small' };
  }
  if (bytes.byteLength > VTO_RESULT_MAX_BYTES) {
    return { ok: false, reason: 'invalid_output', detail: 'result_too_large' };
  }
  const magic = MAGIC_BYTES[media.mediaType];
  if (magic) {
    for (let i = 0; i < magic.length; i += 1) {
      if (bytes[i] !== magic[i]) {
        return { ok: false, reason: 'invalid_output', detail: 'magic_bytes_mismatch' };
      }
    }
  }
  const dimensions = readVtoImageDimensions(bytes, media.mediaType);
  if (!dimensions) return { ok: false, reason: 'invalid_output', detail: 'invalid_image_structure' };
  if ((media.width !== null && media.width !== dimensions.width) ||
      (media.height !== null && media.height !== dimensions.height)) {
    return { ok: false, reason: 'invalid_output', detail: 'dimension_mismatch' };
  }
  return { ok: true, media: { ...media, ...dimensions }, byteLength: bytes.byteLength };
}
