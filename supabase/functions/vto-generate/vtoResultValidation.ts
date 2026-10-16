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


// Parse structural image dimensions without fully decoding customer pixels.
// Actual identity and garment fidelity remain a separate human QA gate.
function structuralDimensions(bytes: Uint8Array, kind: string): [number, number] | null {
  const be32 = (p: number) => ((bytes[p] * 0x1000000) +
    (bytes[p+1] << 16) + (bytes[p+2] << 8) + bytes[p+3]) >>> 0;
  const le32 = (p: number) => (bytes[p] + bytes[p+1] * 256 +
    bytes[p+2] * 65536 + bytes[p+3] * 16777216) >>> 0;
  if (kind === 'image/png') {
    // Signature, IHDR length=13 and name, end marker. Reject truncated PNGs.
    if (bytes.length < 57 || be32(8) !== 13 ||
        String.fromCharCode(...bytes.slice(12,16)) !== 'IHDR' ||
        String.fromCharCode(...bytes.slice(-8,-4)) !== 'IEND') return null;
    return [be32(16), be32(20)];
  }
  if (kind === 'image/jpeg') {
    if (bytes.length < 8 || bytes[bytes.length-2] !== 0xff ||
        bytes[bytes.length-1] !== 0xd9) return null;
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (i+1 >= bytes.length) return null;
      const length = (bytes[i] << 8) | bytes[i+1];
      if (length < 2 || i + length > bytes.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]
          .includes(marker)) {
        if (length < 7) return null;
        return [(bytes[i+5] << 8) | bytes[i+6],
                (bytes[i+3] << 8) | bytes[i+4]];
      }
      i += length;
    }
    return null;
  }
  if (kind === 'image/webp') {
    if (bytes.length < 30 || String.fromCharCode(...bytes.slice(8,12)) !== 'WEBP' ||
        le32(4) + 8 !== bytes.length) return null;
    const tag = String.fromCharCode(...bytes.slice(12,16));
    if (tag === 'VP8X') return [
      1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
      1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
    ];
    if (tag === 'VP8L' && bytes[20] === 0x2f) return [
      1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
      1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
    ];
    if (tag === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d &&
        bytes[24] === 0x01 && bytes[25] === 0x2a) return [
      (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    ];
  }
  return null;
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
  const dimensions = structuralDimensions(bytes, media.mediaType);
  if (!dimensions) return { ok: false, reason: 'invalid_output', detail: 'invalid_image_structure' };
  const [width, height] = dimensions;
  if (width < 64 || height < 64 || width > 8192 || height > 8192 ||
      width * height > 16_777_216) {
    return { ok: false, reason: 'invalid_output', detail: 'invalid_image_dimensions' };
  }
  if ((media.width != null && media.width !== width) ||
      (media.height != null && media.height !== height)) {
    return { ok: false, reason: 'invalid_output', detail: 'image_dimensions_mismatch' };
  }
  return { ok: true, media: { ...media, width, height }, byteLength: bytes.byteLength };
}
