import { createHash } from 'node:crypto';
import type { RgbaImageBuffer, DetectedPiiRegion, MaskingResult } from './types';
import { validateBox } from './boundingBoxes';

export interface RedactionColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const DEFAULT_REDACTION_COLOR: RedactionColor = { r: 0, g: 0, b: 0, a: 255 };

function hashBuffer(pixels: Uint8Array): string {
  return createHash('sha256').update(pixels).digest('hex');
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
  if (!buffer.pixels || !(buffer.pixels instanceof Uint8Array)) {
    throw new Error('Invalid RGBA buffer: pixels must be a Uint8Array.');
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

  const inputHash = hashBuffer(input.pixels);
  const outputHash = hashBuffer(output.pixels);
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
