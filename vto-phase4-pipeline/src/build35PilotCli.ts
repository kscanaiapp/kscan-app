/** Reproduce the accepted Build 35 pilot with the existing Phase 4 pipeline.
 * This checks the governed output; it never overwrites bundled assets. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeImageBytes, encodePng } from './codec';
import { runPipelineForImage } from './pipeline';
import { repoRoot } from './realFixtureCatalog';
import type { Phase4ProductInput } from './types';

async function main() {
  const root = repoRoot();
  const sourceRef = 'vto-phase4-pipeline/fixtures-input/pilot/ascolour-5001-black.jpg';
  const product: Phase4ProductInput = {
    productRef: 'https://ascolour.com/staple-tee-5001/?Colour=Black',
    retailer: 'AS Colour', variantId: 'Black', variantAuthoritative: true,
    category: 'top', title: 'Staple Tee 5001 - Black', brand: 'AS Colour',
    images: [{ ref: sourceRef, origin: 'local-fixture' }], evidenceClass: 'COMMITTED_REAL_PRODUCT_FIXTURE',
  };
  const decoded = await decodeImageBytes(readFileSync(join(root, sourceRef)));
  // Existing operator correction. Default 0.448 confidence rejected due to
  // disconnected JPEG/shadow speckles. Threshold 50 gives 0.567 and removes
  // those speckles; the silhouette/texture were visually inspected. No QA or
  // eligibility threshold is lowered, and no manifest field is patched.
  const result = runPipelineForImage(product, sourceRef, decoded, { segmentationThresholdOverride: 50 });
  if (!result.manifest.qa?.passed || !result.manifest.eligibility.live2d || !result.texture || !result.alphaMask) {
    throw new Error(`Pilot rejected: ${JSON.stringify(result.manifest.rejection)}`);
  }
  const bundled = join(root, 'modules/kscan-live-vto-native/android/src/main/assets/ascolour-5001-black-v1');
  const expected = JSON.parse(readFileSync(join(bundled, 'manifest.json'), 'utf8'));
  if (expected.assetId !== result.manifest.assetId || expected.source.sha256 !== result.manifest.source.sha256) throw new Error('Pilot identity drift');
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  for (const [name, image] of [['texture.png', result.texture], ['alpha.png', result.alphaMask]] as const) {
    // Encode through the same PNG writer the asset factory uses.
    const actual = encodePng(image);
    if (sha(actual) !== sha(readFileSync(join(bundled, name)))) throw new Error(`Pilot ${name} drift`);
  }
  console.log(JSON.stringify({ assetId: expected.assetId, qaPassed: true, eligible: true, correctionThreshold: 50 }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
