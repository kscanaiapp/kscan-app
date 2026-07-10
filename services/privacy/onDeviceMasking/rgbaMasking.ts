import type { RgbaImageBuffer, DetectedPiiRegion, MaskingResult } from './types';
import { validateBox } from './boundingBoxes';

export interface RedactionColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const DEFAULT_REDACTION_COLOR: RedactionColor = { r: 0, g: 0, b: 0, a: 255 };

// Maximum accepted image dimensions and total pixel-buffer byte length.
// This bounds worst-case allocation/iteration cost for a malformed or
// hostile input; 8192x8192 comfortably exceeds any current mobile camera
// capture resolution while remaining far below a size that could stall or
// crash a device (8192 * 8192 * 4 = 256 MiB).
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_BUFFER_BYTE_LENGTH = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION * 4;

/**
 * Deterministic, dependency-free 64-bit FNV-1a checksum, hex-encoded.
 *
 * This is NOT a cryptographic hash. It exists only to give POC callers and
 * tests a cheap way to assert "the buffer changed" / "the buffer did not
 * change" without pulling in a native or WASM crypto dependency, and without
 * relying on Node's `crypto` module, which does not exist in the React
 * Native runtime. Do not use this value for integrity verification against
 * an adversarial input, deduplication across untrusted sources, or any
 * security-sensitive comparison — use a real cryptographic hash for those.
 */
function checksumBuffer(pixels: Uint8Array): string {
  // FNV-1a over two independent 32-bit lanes, combined, to reduce collision
  // probability versus a single 32-bit checksum while staying dependency-free.
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < pixels.length; i++) {
    h1 ^= pixels[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 = (h2 ^ pixels[i]) + ((h2 << 6) + (h2 >>> 2));
    h2 = h2 >>> 0;
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  const lengthHex = (pixels.length >>> 0).toString(16).padStart(8, '0');
  return `${hex1}${hex2}${lengthHex}`;
}

function validateImageBuffer(buffer: RgbaImageBuffer): void {
  if (!buffer || typeof buffer !== 'object' || Array.isArray(buffer)) {
    throw new Error('Invalid RGBA buffer: must be an object.');
  }
  if (typeof buffer.width !== 'number' || !Number.isInteger(buffer.width) || buffer.width <= 0) {
    throw new Error('Invalid RGBA buffer: width must be a positive integer.');
  }
  if (typeof buffer.height !== 'number' || !Number.isInteger(buffer.height) || buffer.height <= 0) {
    throw new Error('Invalid RGBA buffer: height must be a positive integer.');
  }
  // Bound dimensions before any multiplication or allocation is attempted.
  if (buffer.width > MAX_IMAGE_DIMENSION || buffer.height > MAX_IMAGE_DIMENSION) {
    throw new Error(
      `Invalid RGBA buffer: dimensions ${buffer.width}x${buffer.height} exceed the maximum of ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}.`,
    );
  }
  if (!buffer.pixels || !(buffer.pixels instanceof Uint8Array)) {
    throw new Error('Invalid RGBA buffer: pixels must be a Uint8Array.');
  }
  if (buffer.pixels.length > MAX_BUFFER_BYTE_LENGTH) {
    throw new Error(
      `Invalid RGBA buffer: byte length ${buffer.pixels.length} exceeds the maximum of ${MAX_BUFFER_BYTE_LENGTH}.`,
    );
  }
  const expected = buffer.width * buffer.height * 4;
  if (buffer.pixels.length !== expected) {
    throw new Error(
      `Invalid RGBA buffer: expected ${expected} bytes for ${buffer.width}x${buffer.height}, got ${buffer.pixels.length}.`,
    );
  }
}

function clampColorComponent(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Apply solid-pixel redaction to the supplied RGBA regions.
 *
 * - The input buffer is never mutated; a copy is modified.
 * - Regions are clamped to image bounds and validated.
 * - Returns truthful `pixelsChanged` and hashes.
 * - Fails when a requested valid region cannot be fully processed.
 */
export function maskRgbaRegions(
  input: RgbaImageBuffer,
  regions: DetectedPiiRegion[],
  options?: { redactionColor?: RedactionColor },
): MaskingResult {
  const startedAt = Date.now();

  validateImageBuffer(input);

  const output: RgbaImageBuffer = {
    width: input.width,
    height: input.height,
    pixels: new Uint8Array(input.pixels),
  };

  const color = options?.redactionColor ?? DEFAULT_REDACTION_COLOR;
  const r = clampColorComponent(color.r);
  const g = clampColorComponent(color.g);
  const b = clampColorComponent(color.b);
  const a = clampColorComponent(color.a);

  const warnings: string[] = [];
  let regionsMasked = 0;

  for (const region of regions) {
    if (!region || typeof region !== 'object' || Array.isArray(region)) {
      warnings.push('Skipping invalid region object.');
      continue;
    }

    const validated = validateBox(region.box, input.width, input.height);
    if (!validated.valid) {
      warnings.push(`Skipping invalid region: ${validated.reason}`);
      continue;
    }

    const box = validated.box;
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        const idx = (y * input.width + x) * 4;
        output.pixels[idx] = r;
        output.pixels[idx + 1] = g;
        output.pixels[idx + 2] = b;
        output.pixels[idx + 3] = a;
      }
    }
    regionsMasked += 1;
  }

  const inputHash = checksumBuffer(input.pixels);
  const outputHash = checksumBuffer(output.pixels);
  let pixelsChanged = false;
  if (input.pixels.length !== output.pixels.length) {
    pixelsChanged = true;
  } else {
    for (let i = 0; i < input.pixels.length; i++) {
      if (input.pixels[i] !== output.pixels[i]) {
        pixelsChanged = true;
        break;
      }
    }
  }

  // Safety invariant: if we claimed to mask any region, at least one byte must differ.
  if (regionsMasked > 0 && !pixelsChanged) {
    throw new Error('Masking invariant violated: regions were masked but no pixels changed.');
  }

  return {
    attempted: true,
    completed: true,
    regionsRequested: regions.length,
    regionsMasked,
    inputHash,
    outputHash,
    pixelsChanged,
    output,
    warnings,
    durationMs: Date.now() - startedAt,
  };
}
