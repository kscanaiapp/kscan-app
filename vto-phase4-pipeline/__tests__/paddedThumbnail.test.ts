import test from 'node:test';
import assert from 'node:assert/strict';
import { createImage, getPixel, setPixel, type RgbaImage } from '../src/pixels';
import { decodeImageBytes, encodePng } from '../src/codec';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import { runPipelineForImage } from '../src/pipeline';
import type { Phase4ProductInput } from '../src/types';

/**
 * Addendum §A10: real Google Shopping/RapidAPI commerce thumbnails
 * (verified live during the Gate E access probe — see
 * docs/vto-phase4-gate-e-access-probe.md) are overwhelmingly a small
 * product centered on a much larger uniform-color canvas — white/off-white
 * padding, sometimes a letterbox-like border. This is the single most
 * common real-world shape this pipeline will actually see, so it must be
 * exercised BEFORE the real cohort run, not discovered during it.
 *
 * `generateSyntheticGarment` already renders onto a fixed canvas; this
 * composites a normally-proportioned rendered garment onto a much larger
 * uniform-color canvas, centered — i.e. exactly the "product occupies a
 * small fraction of a large image" shape §A10 asks for. Purely synthetic,
 * no real/retailer imagery.
 */
function padWithBorder(source: RgbaImage, paddedWidth: number, paddedHeight: number, padColor: [number, number, number]): RgbaImage {
  const out = createImage(paddedWidth, paddedHeight);
  for (let y = 0; y < paddedHeight; y++) {
    for (let x = 0; x < paddedWidth; x++) {
      setPixel(out, x, y, padColor[0], padColor[1], padColor[2], 255);
    }
  }
  const offsetX = Math.round((paddedWidth - source.width) / 2);
  const offsetY = Math.round((paddedHeight - source.height) / 2);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const [r, g, b, a] = getPixel(source, x, y);
      const dstX = offsetX + x;
      const dstY = offsetY + y;
      if (dstX >= 0 && dstX < paddedWidth && dstY >= 0 && dstY < paddedHeight) {
        setPixel(out, dstX, dstY, r, g, b, a);
      }
    }
  }
  return out;
}

const WHITE: [number, number, number] = [248, 248, 248];
const OFF_WHITE: [number, number, number] = [238, 236, 230];
const BLUE: [number, number, number] = [40, 90, 170];

function product(overrides: Partial<Phase4ProductInput> = {}): Phase4ProductInput {
  return {
    productRef: 'p-padded-thumbnail',
    retailer: null,
    variantId: null,
    variantAuthoritative: false,
    category: 'top',
    title: null,
    brand: null,
    images: [],
    evidenceClass: 'SYNTHETIC',
    ...overrides,
  };
}

test('padded thumbnail (product ~40% short-side of canvas, white padding): extracts a texture close to the garment size, never the padded canvas size', async () => {
  const garment = generateSyntheticGarment({ seed: 11, canvasWidth: 320, canvasHeight: 360, backgroundColor: WHITE, garmentColor: BLUE });
  // 2.5x canvas in each dimension — garment occupies roughly (1/2.5)^2 = 16% of the padded image area.
  const padded = padWithBorder(garment.image, 800, 900, WHITE);
  const decoded = await decodeImageBytes(encodePng(padded));

  const runResult = runPipelineForImage(product(), 'padded-white.png', decoded);
  const m = runResult.manifest;

  // Whatever the pipeline decides (accept or a specific clean rejection), it
  // must never silently produce a texture dominated by padding: an
  // accepted texture's area must be much closer to the ORIGINAL garment
  // render's canvas area than to the padded canvas's area.
  if (m.eligibility.live2d) {
    assert.ok(runResult.texture, 'an eligible asset must have a texture');
    const textureArea = runResult.texture!.width * runResult.texture!.height;
    const paddedArea = 800 * 900;
    const garmentCanvasArea = 320 * 360;
    assert.ok(
      textureArea < paddedArea * 0.5,
      `texture (${runResult.texture!.width}x${runResult.texture!.height}) must not be dominated by padding — got ${textureArea}px vs padded canvas ${paddedArea}px`,
    );
    assert.ok(
      textureArea < garmentCanvasArea * 3,
      `texture area ${textureArea}px is implausibly larger than the garment's own render canvas (${garmentCanvasArea}px) for a correctly-cropped extraction`,
    );
  } else {
    assert.ok(m.rejection, 'a non-eligible result must carry a specific rejection reason, never a silent failure');
  }
});

test('padded thumbnail with very small product occupancy (<4% of canvas area) is either cropped tightly or rejected cleanly — never accepted as an oversized padding-dominated texture', async () => {
  const garment = generateSyntheticGarment({ seed: 12, canvasWidth: 200, canvasHeight: 220, backgroundColor: WHITE, garmentColor: BLUE });
  // 5x canvas in each dimension — occupancy roughly (1/5)^2 = 4% of the padded image.
  const padded = padWithBorder(garment.image, 1000, 1100, WHITE);
  const decoded = await decodeImageBytes(encodePng(padded));

  const runResult = runPipelineForImage(product(), 'padded-tiny.png', decoded);
  const m = runResult.manifest;

  if (m.eligibility.live2d) {
    const textureArea = runResult.texture!.width * runResult.texture!.height;
    const paddedArea = 1000 * 1100;
    assert.ok(textureArea < paddedArea * 0.25, `accepted texture must be tightly cropped to the garment, not the padded canvas — got ${textureArea}px of ${paddedArea}px`);
  } else {
    assert.ok(m.rejection, 'must reject with a specific reason, not silently');
    assert.ok(typeof m.rejection!.code === 'string' && m.rejection!.code.length > 0, 'sanity: rejection code must be a real, non-empty RejectionCode');
  }
  assert.equal(m.status === 'REJECTED' || m.eligibility.live2d, true);
});

test('padded thumbnail with off-white (not pure-white) padding is still recognized as a uniform background', async () => {
  const garment = generateSyntheticGarment({ seed: 13, canvasWidth: 320, canvasHeight: 360, backgroundColor: OFF_WHITE, garmentColor: BLUE });
  const padded = padWithBorder(garment.image, 700, 800, OFF_WHITE);
  const decoded = await decodeImageBytes(encodePng(padded));

  const runResult = runPipelineForImage(product(), 'padded-offwhite.png', decoded);
  const m = runResult.manifest;
  assert.equal(m.shotClassification.evidence.reason !== 'coverage_out_of_analyzable_range', true, 'off-white padding must not be mistaken for foreground coverage collapse');
  // The padding itself must never register as the primary "garment" — the
  // measured foreground coverage must be well under half the frame.
  const coverage = Number(m.shotClassification.evidence.coverage ?? 1);
  assert.ok(coverage < 0.5, `padding must not be counted as foreground (coverage=${coverage})`);
});

test('padded thumbnail never produces a manifest whose source dimensions and garment-bounding dimensions are silently equal (that would mean padding was treated as garment)', async () => {
  const garment = generateSyntheticGarment({ seed: 14, canvasWidth: 260, canvasHeight: 300, backgroundColor: WHITE, garmentColor: BLUE });
  const padded = padWithBorder(garment.image, 650, 750, WHITE);
  const decoded = await decodeImageBytes(encodePng(padded));

  const runResult = runPipelineForImage(product(), 'padded-adequacy.png', decoded);
  const m = runResult.manifest;

  assert.equal(m.sourceAdequacy.sourceWidth, 650);
  assert.equal(m.sourceAdequacy.sourceHeight, 750);
  if (m.sourceAdequacy.garmentBoundingWidthPx !== null) {
    assert.ok(
      m.sourceAdequacy.garmentBoundingWidthPx < 650 * 0.9,
      'garment bounding box must be measurably smaller than the padded source — padding must not be counted as garment',
    );
    assert.ok(m.sourceAdequacy.garmentOccupancyRatio !== null && m.sourceAdequacy.garmentOccupancyRatio < 0.5);
  }
});
