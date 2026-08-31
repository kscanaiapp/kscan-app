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
  return { ok: true, media, byteLength: bytes.byteLength };
}
