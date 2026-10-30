/** Cheap container checks before a remote garment can buy a generation.
 * This is not pixel decoding or a visual-quality/complete codec validator.
 * PNG: https://www.w3.org/TR/png-3/
 * WebP: https://developers.google.com/speed/webp/docs/riff_container
 * AVIF brands: https://aomediacodec.github.io/av1-avif/
 */
export function hasRemoteGarmentImageContainer(bytes: Uint8Array, mediaType: string): boolean {
  if (bytes.length < 12) return false;
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (mediaType) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
        bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    case 'image/png':
      return bytes.length >= 57 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value) &&
        view.getUint32(8) === 13 && text(12, 4) === 'IHDR' &&
        view.getUint32(16) > 0 && view.getUint32(20) > 0 &&
        view.getUint32(bytes.length - 12) === 0 && text(bytes.length - 8, 4) === 'IEND';
    case 'image/webp':
      return bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP' &&
        view.getUint32(4, true) + 8 === bytes.length;
    case 'image/avif': {
      // A bounded ftyp box must identify AVIF (major or compatible brand).
      // Do not mistake the minor-version field at offset12 for a brand.
      if (bytes.length < 24 || text(4, 4) !== 'ftyp') return false;
      const boxEnd = view.getUint32(0);
      if (boxEnd < 16 || boxEnd % 4 !== 0 || boxEnd > bytes.length - 8) return false;
      if (['avif', 'avis'].includes(text(8, 4))) return true;
      for (let i = 16; i < boxEnd; i += 4) {
        if (['avif', 'avis'].includes(text(i, 4))) return true;
      }
      return false;
    }
    default:
      return false;
  }
}
