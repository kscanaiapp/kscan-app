import type { RgbaImageBuffer, DetectedPiiRegion, MaskingResult } from './types';
import { validateBox } from './boundingBoxes';

export interface MaskingVerification {
  passed: boolean;
  regionsVerified: number;
  regionsFailed: number;
  failures: string[];
}

/**
 * Verify that every validated region in the output buffer has actually been
 * changed from the input buffer. This catches masking implementations that
 * accidentally skip pixels or return the original buffer.
 */
export function verifyMasking(
  input: RgbaImageBuffer,
  output: RgbaImageBuffer,
  regions: DetectedPiiRegion[],
): MaskingVerification {
  const failures: string[] = [];
  let regionsVerified = 0;
  let regionsFailed = 0;

  if (!input || !output) {
    return { passed: false, regionsVerified: 0, regionsFailed: regions.length, failures: ['Missing input or output buffer.'] };
  }

  if (input.width !== output.width || input.height !== output.height) {
    failures.push('Input and output dimensions do not match.');
  }

  if (input.pixels.length !== output.pixels.length) {
    failures.push('Input and output pixel arrays have different lengths.');
  }

  for (const region of regions) {
    const validated = validateBox(region.box, output.width, output.height);
    if (!validated.valid) {
      failures.push(`Region validation failed: ${validated.reason}`);
      regionsFailed += 1;
      continue;
    }

    const box = validated.box;
    let changed = false;
    for (let y = box.y; y < box.y + box.height && !changed; y++) {
      for (let x = box.x; x < box.x + box.width && !changed; x++) {
        const idx = (y * output.width + x) * 4;
        if (
          input.pixels[idx] !== output.pixels[idx] ||
          input.pixels[idx + 1] !== output.pixels[idx + 1] ||
          input.pixels[idx + 2] !== output.pixels[idx + 2] ||
          input.pixels[idx + 3] !== output.pixels[idx + 3]
        ) {
          changed = true;
        }
      }
    }

    if (changed) {
      regionsVerified += 1;
    } else {
      regionsFailed += 1;
      failures.push(`Region at (${box.x}, ${box.y}) was not modified.`);
    }
  }

  return {
    passed: failures.length === 0,
    regionsVerified,
    regionsFailed,
    failures,
  };
}

/**
 * Verify that the masking result completed and actually changed pixels.
 */
export function verifyMaskingResult(result: MaskingResult): { passed: boolean; failures: string[] } {
  const failures: string[] = [];

  if (!result.completed) {
    failures.push('Masking did not complete.');
  }
  if (result.regionsMasked !== result.regionsRequested) {
    failures.push(`Only ${result.regionsMasked} of ${result.regionsRequested} requested regions were masked.`);
  }
  if (!result.pixelsChanged) {
    failures.push('No pixels were changed.');
  }
  if (result.inputHash === result.outputHash) {
    failures.push('Input and output hashes are identical.');
  }
  if (!result.output) {
    failures.push('No output buffer was produced.');
  }

  return { passed: failures.length === 0, failures };
}
