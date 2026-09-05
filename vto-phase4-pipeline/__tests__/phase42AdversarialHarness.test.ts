import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBatch } from '../src/batch';
import { runPipelineForImage } from '../src/pipeline';
import { writePngFile } from '../src/codec';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import { fillBackground, fillRect } from '../src/drawing';
import { createImage, setPixel, type RgbaImage } from '../src/pixels';
import type { DecodedSource } from '../src/codec';
import type { Phase4ProductInput } from '../src/types';

/**
 * Phase 4.2 §47 — ADVERSARIAL BUILD HARNESS.
 *
 * Every listed case must TERMINATE PREDICTABLY and FAIL CLOSED. "Fail
 * closed" here means exactly one of: a rejection with a real code, or a
 * SystemError — never `LIVE2D_ELIGIBLE`, never a hang, never a throw that
 * escapes the batch.
 *
 * These are deliberately hostile inputs, not representative ones. They are
 * never used to tune a threshold (§40): nothing in this file feeds a
 * calibration.
 */

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];
const RED: [number, number, number] = [196, 40, 40];

function asDecoded(image: RgbaImage): DecodedSource {
  return { image, sha256: 'adv-sha', format: 'png', byteLength: image.data.length };
}

function product(productRef: string, images: Phase4ProductInput['images'] = []): Phase4ProductInput {
  return {
    productRef,
    retailer: null,
    variantId: null,
    variantAuthoritative: false,
    category: 'top',
    title: null,
    brand: null,
    images,
    evidenceClass: 'SYNTHETIC',
  };
}

function solid(width: number, height: number, color: [number, number, number]): RgbaImage {
  const img = createImage(width, height);
  fillBackground(img, color);
  return img;
}

/** Asserts the single invariant every adversarial case shares. */
function assertFailsClosed(label: string, manifest: { eligibility: { live2d: boolean }; rejection: { code: string } | null }) {
  assert.equal(manifest.eligibility.live2d, false, label + ': must never be LIVE2D_ELIGIBLE');
  assert.ok(manifest.rejection !== null, label + ': must carry a real rejection code, not a silent ineligibility');
  assert.ok(typeof manifest.rejection.code === 'string' && manifest.rejection.code.length > 0, label + ': rejection code must be populated');
}

// ── Pixel-level adversarial inputs ───────────────────────────────────────

test('§47 no garment: a uniform empty frame fails closed', () => {
  const r = runPipelineForImage(product('adv-empty'), 'e.png', asDecoded(solid(300, 300, WHITE)), {});
  assertFailsClosed('no garment', r.manifest);
});

test('§47 near-empty foreground: a single foreground pixel fails closed', () => {
  const img = solid(300, 300, WHITE);
  setPixel(img, 150, 150, 0, 0, 0, 255);
  const r = runPipelineForImage(product('adv-1px'), 'p.png', asDecoded(img), {});
  assertFailsClosed('1-pixel foreground', r.manifest);
});

test('§47 multiple garments: a scattered-object scene fails closed', () => {
  const img = generateSyntheticGarment({ seed: 301, backgroundColor: WHITE, garmentColor: BLUE, scatterExtraObjects: true }).image;
  const r = runPipelineForImage(product('adv-multi'), 'm.png', asDecoded(img), { fidelityHints: { knownFillColor: BLUE } });
  assertFailsClosed('multiple garments', r.manifest);
});

test('§47 extreme aspect ratio: a 1000x40 sliver fails closed', () => {
  const img = solid(1000, 40, WHITE);
  fillRect(img, 100, 5, 900, 35, BLUE);
  const r = runPipelineForImage(product('adv-aspect'), 'a.png', asDecoded(img), {});
  assertFailsClosed('extreme aspect ratio', r.manifest);
});

test('§47 pure noise: a fully random frame fails closed', () => {
  const img = createImage(300, 300);
  let state = 7;
  for (let i = 0; i < 300 * 300; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    img.data[i * 4] = state % 256;
    img.data[i * 4 + 1] = (state >> 8) % 256;
    img.data[i * 4 + 2] = (state >> 16) % 256;
    img.data[i * 4 + 3] = 255;
  }
  const r = runPipelineForImage(product('adv-noise'), 'n.png', asDecoded(img), {});
  assertFailsClosed('pure noise', r.manifest);
});

test('§47 gradient background: a smooth gradient with no garment fails closed', () => {
  const img = createImage(300, 300);
  for (let y = 0; y < 300; y++) {
    for (let x = 0; x < 300; x++) {
      const v = Math.round((x / 300) * 255);
      setPixel(img, x, y, v, v, v, 255);
    }
  }
  const r = runPipelineForImage(product('adv-gradient'), 'g.png', asDecoded(img), {});
  assertFailsClosed('gradient background', r.manifest);
});

test('§47 text-only image: dense small marks with no garment fails closed', () => {
  const img = solid(300, 300, WHITE);
  for (let row = 0; row < 12; row++) {
    for (let x = 20; x < 280; x += 4) {
      fillRect(img, x, 30 + row * 20, x + 2, 30 + row * 20 + 8, [20, 20, 20]);
    }
  }
  const r = runPipelineForImage(product('adv-text'), 't.png', asDecoded(img), {});
  assertFailsClosed('text-only', r.manifest);
});

test('§47 model-worn: a skin-tone subject fails closed with OCCLUSION_TOO_HIGH', () => {
  const img = generateSyntheticGarment({ seed: 302, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image;
  const r = runPipelineForImage(product('adv-worn'), 'w.png', asDecoded(img), {});
  assertFailsClosed('model-worn', r.manifest);
  assert.equal(r.manifest.rejection?.code, 'OCCLUSION_TOO_HIGH');
});

test('§47 garment partially outside crop: an edge-clipped garment fails closed', () => {
  const img = solid(300, 300, WHITE);
  // Deliberately overruns every edge.
  fillRect(img, -50, -50, 350, 350, BLUE);
  const r = runPipelineForImage(product('adv-crop'), 'c.png', asDecoded(img), {});
  assertFailsClosed('crop incomplete', r.manifest);
});

test('§47 huge padding: a tiny garment inside a vast white canvas terminates predictably', () => {
  const img = solid(800, 800, WHITE);
  fillRect(img, 390, 390, 410, 410, BLUE);
  const r = runPipelineForImage(product('adv-padding'), 'pd.png', asDecoded(img), {});
  assertFailsClosed('huge padding', r.manifest);
});

test('§47 padding is never treated as garment (§27)', () => {
  const img = solid(600, 600, WHITE);
  fillRect(img, 250, 250, 350, 350, BLUE);
  const r = runPipelineForImage(product('adv-pad2'), 'pd2.png', asDecoded(img), {});
  const evidence = r.manifest.segmentationEvidence;
  if (evidence) {
    // The garment is 100x100 = 10,000 px inside a 360,000 px frame. If padding
    // were being absorbed, the mask would be far larger than the drawn square.
    assert.ok(
      evidence.maskPixelCount < 20000,
      'mask must not absorb background padding; got ' + evidence.maskPixelCount + ' px for a 10,000 px garment',
    );
  }
});

// ── Batch-level adversarial inputs (terminal accounting, §66) ────────────

test('§47 corrupt image: a truncated file terminates as a SystemError, never as eligible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adv-corrupt-'));
  try {
    const corrupt = join(dir, 'corrupt.png');
    writeFileSync(corrupt, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]));

    const result = await runBatch([product('adv-corrupt', [{ ref: corrupt, origin: 'local-fixture' }])], {
      outputRoot: dir,
      persist: false,
      concurrency: 1,
      maxRetries: 0,
    });

    assert.equal(result.items.length, 1, 'N-in must equal N-out');
    const item = result.items[0];
    assert.ok(item.systemError !== null, 'a corrupt source must be a SystemError, not a catalog rejection');
    assert.equal(item.manifest, null, 'no manifest may be built for a system error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§47 zero-byte image: terminates as a SystemError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adv-zero-'));
  try {
    const empty = join(dir, 'zero.png');
    writeFileSync(empty, Buffer.alloc(0));

    const result = await runBatch([product('adv-zero', [{ ref: empty, origin: 'local-fixture' }])], {
      outputRoot: dir,
      persist: false,
      concurrency: 1,
      maxRetries: 0,
    });
    assert.equal(result.items.length, 1);
    assert.ok(result.items[0].systemError !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§47 duplicate candidates: identical images do not double-count or crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adv-dupe-'));
  try {
    const g = generateSyntheticGarment({ seed: 303, backgroundColor: WHITE, garmentColor: BLUE });
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    writePngFile(a, g.image);
    writePngFile(b, g.image);

    const result = await runBatch(
      [product('adv-dupe', [
        { ref: a, origin: 'local-fixture' },
        { ref: b, origin: 'local-fixture' },
      ])],
      { outputRoot: dir, persist: false, concurrency: 1, maxRetries: 0 },
    );

    assert.equal(result.items.length, 1, 'one product in, one item out');
    assert.equal(result.items[0].evaluatedImages.length, 2, 'both candidates evaluated');
    assert.ok(result.items[0].systemError === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§47 wrong variant: a differing-colour alternate never becomes the asset source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adv-variant-'));
  try {
    // Hero is model-worn (HARD, would be rejected); the alternate is a clean
    // flat lay of a DIFFERENT colour. Ranking alone would substitute it.
    const hero = generateSyntheticGarment({ seed: 304, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true });
    const alt = generateSyntheticGarment({ seed: 304, backgroundColor: WHITE, garmentColor: RED });
    const heroPath = join(dir, 'hero.png');
    const altPath = join(dir, 'alt.png');
    writePngFile(heroPath, hero.image);
    writePngFile(altPath, alt.image);

    const result = await runBatch(
      [product('adv-variant', [
        { ref: heroPath, origin: 'local-fixture' },
        { ref: altPath, origin: 'local-fixture' },
      ])],
      { outputRoot: dir, persist: false, concurrency: 1, maxRetries: 0 },
    );

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].selectedImageRef, heroPath, 'must keep the hero, not substitute a different colourway');
    assert.equal(result.items[0].manifest?.eligibility.live2d, false, 'and the product stays rejected rather than wrongly rescued');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§47 batch isolation: one hostile item never destroys its siblings (N-in = N-out)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adv-batch-'));
  try {
    const good = generateSyntheticGarment({ seed: 305, backgroundColor: WHITE, garmentColor: BLUE });
    const goodPath = join(dir, 'good.png');
    writePngFile(goodPath, good.image);
    const corruptPath = join(dir, 'bad.png');
    writeFileSync(corruptPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const inputs = [
      product('adv-good-1', [{ ref: goodPath, origin: 'local-fixture' }]),
      product('adv-bad', [{ ref: corruptPath, origin: 'local-fixture' }]),
      product('adv-good-2', [{ ref: goodPath, origin: 'local-fixture' }]),
      product('adv-missing', [{ ref: join(dir, 'nope.png'), origin: 'local-fixture' }]),
    ];

    const result = await runBatch(inputs, { outputRoot: dir, persist: false, concurrency: 4, maxRetries: 0 });

    assert.equal(result.items.length, inputs.length, 'N-in must equal N-out even with hostile items present');
    const terminal = result.items.every(
      (i) => i.systemError !== null || i.manifest?.rejection !== null || i.manifest?.eligibility.live2d === true,
    );
    assert.ok(terminal, 'every item must reach exactly one terminal state');
    assert.equal(result.items.filter((i) => i.systemError !== null).length, 2, 'both hostile items must be SystemErrors');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§47 no adversarial case in this suite is ever LIVE2D_ELIGIBLE', async () => {
  // A belt-and-braces sweep: the pixel-level hostile inputs, run together,
  // must yield zero eligible outcomes.
  const hostile: RgbaImage[] = [
    solid(300, 300, WHITE),
    solid(1000, 40, WHITE),
    generateSyntheticGarment({ seed: 306, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image,
    generateSyntheticGarment({ seed: 307, backgroundColor: WHITE, garmentColor: BLUE, scatterExtraObjects: true }).image,
  ];
  for (const [i, img] of hostile.entries()) {
    const r = runPipelineForImage(product('sweep-' + i), 's.png', asDecoded(img), {});
    assert.equal(r.manifest.eligibility.live2d, false, 'hostile input ' + i + ' must not be eligible');
  }
});
