// JPEG metadata inspector.
//
// WHY THIS EXISTS. "Re-encoding through expo-image-manipulator strips EXIF" is
// true, and it was still not good enough. It is an assumption about a native
// library's behaviour on two platforms across future upgrades, and the thing it
// guards is a GPS coordinate attached to a photograph of the user's body. So
// Mirror does not assume it: every generated crop is INSPECTED before it is
// accepted, and a crop carrying metadata is destroyed rather than shown.
//
// This is a deliberately small, total parser. It walks the JPEG segment chain
// and reports which application/comment markers are present. It does not decode
// pixels, does not decode EXIF IFDs, and cannot throw on malformed input — an
// unparseable file is reported as such and treated as unsafe by the caller.

/** Markers that can carry identifying metadata. */
export type JpegMetadataMarker =
  /** Exif (GPS, capture time, device make/model) and XMP both live here. */
  | 'APP1'
  /** ICC colour profiles — benign, but reported so callers can decide. */
  | 'APP2'
  /** Photoshop IRB, which carries IPTC: creator, location, description. */
  | 'APP13'
  /** Free-text comment. Has held original filenames in the wild. */
  | 'COM';

export type JpegInspection =
  | {
      kind: 'ok';
      /** Present metadata-bearing markers, deduped, in file order. */
      markers: JpegMetadataMarker[];
      /** True when an APP1 segment begins with the "Exif\0\0" signature. */
      hasExif: boolean;
      /** True when an APP1 Exif segment declares a GPS IFD pointer (tag 0x8825). */
      hasGps: boolean;
    }
  | { kind: 'unparseable'; reason: 'not_jpeg' | 'truncated' | 'malformed' };

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const COM = 0xfe;

const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const GPS_IFD_TAG = 0x8825;

/**
 * Decode a Base64 string to bytes without Buffer.
 *
 * React Native has no Node Buffer and this module runs in both the app and the
 * Node test suite, so the decode is done here rather than depending on either
 * environment's global.
 */
export function base64ToBytes(base64: string): Uint8Array | null {
  if (typeof base64 !== 'string') return null;
  const clean = base64.replace(/[\r\n\s]/g, '');
  if (!clean) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = alphabet.indexOf(clean[i]);
    const b = alphabet.indexOf(clean[i + 1]);
    const c = clean[i + 2] === '=' ? 0 : alphabet.indexOf(clean[i + 2]);
    const d = clean[i + 3] === '=' ? 0 : alphabet.indexOf(clean[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (chunk >> 16) & 0xff;
    if (o < out.length) out[o++] = (chunk >> 8) & 0xff;
    if (o < out.length) out[o++] = chunk & 0xff;
  }
  return out;
}

function readUint16(bytes: Uint8Array, offset: number, bigEndian: boolean): number {
  return bigEndian
    ? (bytes[offset] << 8) | bytes[offset + 1]
    : (bytes[offset + 1] << 8) | bytes[offset];
}

function readUint32(bytes: Uint8Array, offset: number, bigEndian: boolean): number {
  return bigEndian
    ? ((bytes[offset] << 24) >>> 0) +
        (bytes[offset + 1] << 16) +
        (bytes[offset + 2] << 8) +
        bytes[offset + 3]
    : ((bytes[offset + 3] << 24) >>> 0) +
        (bytes[offset + 2] << 16) +
        (bytes[offset + 1] << 8) +
        bytes[offset];
}

/**
 * Look for a GPS IFD pointer inside an Exif APP1 payload.
 *
 * Only IFD0 is walked. That is sufficient: the GPS pointer tag is defined to
 * live in IFD0, and this is a presence check, not an extractor.
 */
function exifDeclaresGps(payload: Uint8Array): boolean {
  // payload begins at the "Exif\0\0" signature.
  const tiff = 6;
  if (payload.length < tiff + 8) return false;
  const byteOrder = readUint16(payload, tiff, true);
  let bigEndian: boolean;
  if (byteOrder === 0x4d4d) bigEndian = true;
  else if (byteOrder === 0x4949) bigEndian = false;
  else return false;

  if (readUint16(payload, tiff + 2, bigEndian) !== 0x002a) return false;
  const ifd0 = tiff + readUint32(payload, tiff + 4, bigEndian);
  if (ifd0 + 2 > payload.length) return false;

  const count = readUint16(payload, ifd0, bigEndian);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > payload.length) return false;
    if (readUint16(payload, entry, bigEndian) === GPS_IFD_TAG) return true;
  }
  return false;
}

/**
 * Walk the JPEG segment chain up to the start of scan data.
 *
 * Everything metadata-bearing precedes SOS, so stopping there reads a few
 * hundred bytes instead of several megabytes.
 */
export function inspectJpegBytes(bytes: Uint8Array | null): JpegInspection {
  if (!bytes || bytes.length < 4) return { kind: 'unparseable', reason: 'truncated' };
  if (bytes[0] !== 0xff || bytes[1] !== SOI) return { kind: 'unparseable', reason: 'not_jpeg' };

  const markers: JpegMetadataMarker[] = [];
  let hasExif = false;
  let hasGps = false;
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return { kind: 'unparseable', reason: 'malformed' };
    // Fill bytes are legal padding between segments.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return { kind: 'unparseable', reason: 'truncated' };

    const marker = bytes[offset];
    offset += 1;

    if (marker === SOS || marker === EOI) break;
    // Standalone markers carry no length field.
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return { kind: 'unparseable', reason: 'truncated' };

    const length = readUint16(bytes, offset, true);
    if (length < 2) return { kind: 'unparseable', reason: 'malformed' };
    const payloadStart = offset + 2;
    const payloadEnd = offset + length;
    if (payloadEnd > bytes.length) return { kind: 'unparseable', reason: 'truncated' };

    if (marker === APP1) {
      if (!markers.includes('APP1')) markers.push('APP1');
      const payload = bytes.subarray(payloadStart, payloadEnd);
      const signed =
        payload.length >= EXIF_SIGNATURE.length &&
        EXIF_SIGNATURE.every((b, i) => payload[i] === b);
      if (signed) {
        hasExif = true;
        if (exifDeclaresGps(payload)) hasGps = true;
      }
    } else if (marker === APP2) {
      if (!markers.includes('APP2')) markers.push('APP2');
    } else if (marker === APP13) {
      if (!markers.includes('APP13')) markers.push('APP13');
    } else if (marker === COM) {
      if (!markers.includes('COM')) markers.push('COM');
    }

    offset = payloadEnd;
  }

  return { kind: 'ok', markers, hasExif, hasGps };
}

/**
 * The gate the crop pipeline actually calls.
 *
 * APP2 (ICC colour profile) is NOT disqualifying — it describes the pixels'
 * colour space and carries nothing about the person, the place or the device.
 * Everything else on the list can, so everything else fails.
 *
 * FAIL-CLOSED: an unparseable file is not clean. A crop we cannot inspect is a
 * crop we cannot vouch for, and it is deleted rather than shown.
 */
export function isMetadataFreeJpeg(inspection: JpegInspection): boolean {
  if (!inspection || inspection.kind !== 'ok') return false;
  if (inspection.hasExif || inspection.hasGps) return false;
  return !inspection.markers.some((m) => m === 'APP1' || m === 'APP13' || m === 'COM');
}

/** Convenience: inspect a Base64 payload straight from FileSystem. */
export function inspectJpegBase64(base64: string): JpegInspection {
  return inspectJpegBytes(base64ToBytes(base64));
}
