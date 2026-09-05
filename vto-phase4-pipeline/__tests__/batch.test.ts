import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWithRetry, runBatch } from '../src/batch';
import { generateSyntheticFixtureSet } from '../src/syntheticFixtures';
import type { Phase4ProductInput } from '../src/types';

test('loadWithRetry retries a transient decode failure up to maxRetries, then gives up (task section 42)', () => {
  let calls = 0;
  const flakyLoader = () => {
    calls++;
    return calls < 3
      ? ({ ok: false, rejection: { code: 'SOURCE_INVALID' as const, message: 'decode failed: injected transient failure', stage: 'source_acquisition' as const } })
      : ({ ok: true, decoded: { image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, format: 'png' as const, sha256: 'x', byteLength: 4 } });
  };
  const { result, retryCount } = loadWithRetry({ ref: 'irrelevant', origin: 'local-fixture' }, 5, flakyLoader as any);
  assert.equal(result.ok, true);
  assert.equal(retryCount, 2);
  assert.equal(calls, 3);
});

test('loadWithRetry never retries a terminal (non-decode) failure', () => {
  let calls = 0;
  const alwaysTerminal = () => {
    calls++;
    return { ok: false, rejection: { code: 'SOURCE_TOO_SMALL' as const, message: 'too small', stage: 'source_acquisition' as const } };
  };
  const { retryCount } = loadWithRetry({ ref: 'x', origin: 'local-fixture' }, 5, alwaysTerminal as any);
  assert.equal(retryCount, 0);
  assert.equal(calls, 1);
});

test('runBatch: variant-ambiguous products are isolated from each other and never crash the batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-batch-'));
  try {
    const products: Phase4ProductInput[] = [
      { productRef: 'amb', retailer: null, variantId: 'a', variantAuthoritative: false, category: 'top', title: null, brand: null, images: [{ ref: 'missing.png', origin: 'local-fixture' }], evidenceClass: 'SYNTHETIC' },
      { productRef: 'amb', retailer: null, variantId: 'b', variantAuthoritative: false, category: 'top', title: null, brand: null, images: [{ ref: 'missing2.png', origin: 'local-fixture' }], evidenceClass: 'SYNTHETIC' },
    ];
    const result = await runBatch(products, { outputRoot: dir, concurrency: 2 });
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((i) => i.variantAmbiguous));
    assert.ok(result.items.every((i) => i.manifest?.rejection?.code === 'VARIANT_AMBIGUOUS'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runBatch: a missing-file product is isolated (SOURCE_INVALID) and does not affect other items', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-batch-'));
  const inputDir = mkdtempSync(join(tmpdir(), 'phase4-batch-input-'));
  try {
    const synthetic = generateSyntheticFixtureSet(inputDir);
    const broken: Phase4ProductInput = {
      productRef: 'broken',
      retailer: null,
      variantId: null,
      variantAuthoritative: false,
      category: 'top',
      title: null,
      brand: null,
      images: [{ ref: join(inputDir, 'does-not-exist.png'), origin: 'local-fixture' }],
      evidenceClass: 'SYNTHETIC',
    };
    const result = await runBatch([synthetic.products[0], broken], { outputRoot: dir, concurrency: 2, hintsByRef: synthetic.hintsByRef });
    assert.equal(result.items.length, 2);
    const brokenResult = result.items.find((i) => i.productRef === 'broken')!;
    assert.equal(brokenResult.manifest?.rejection?.code, 'SOURCE_INVALID');
    const okResult = result.items.find((i) => i.productRef === synthetic.products[0].productRef)!;
    assert.equal(okResult.manifest?.rejection, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
  }
});

test('runBatch: re-running the identical batch is idempotent at the asset-store level (no duplicate directories)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-batch-'));
  const inputDir = mkdtempSync(join(tmpdir(), 'phase4-batch-input-'));
  try {
    const synthetic = generateSyntheticFixtureSet(inputDir);
    const subset = synthetic.products.slice(0, 3);
    await runBatch(subset, { outputRoot: dir, hintsByRef: synthetic.hintsByRef });
    const { scanExistingManifests } = await import('../src/assetStore');
    const afterFirst = scanExistingManifests(dir).length;
    await runBatch(subset, { outputRoot: dir, hintsByRef: synthetic.hintsByRef });
    const afterSecond = scanExistingManifests(dir).length;
    assert.equal(afterFirst, afterSecond, 'identical re-run must not create new asset directories');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
  }
});
