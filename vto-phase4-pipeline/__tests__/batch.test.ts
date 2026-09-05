import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWithRetry, runBatch, runIsolated } from '../src/batch';
import { generateSyntheticFixtureSet } from '../src/syntheticFixtures';
import { writePngFile } from '../src/codec';
import { createImage } from '../src/pixels';
import type { Phase4ProductInput } from '../src/types';

// ── loadWithRetry: transient-vs-terminal retry semantics (task §42, addendum §48) ──

test('loadWithRetry retries SOURCE_FETCH_FAILED up to maxRetries, then succeeds', async () => {
  let calls = 0;
  const flakyLoader = async () => {
    calls++;
    return calls < 3
      ? ({ ok: false, kind: 'systemError' as const, systemError: { code: 'SOURCE_FETCH_FAILED' as const, message: 'injected transient failure', stage: 'source_acquisition' as const } })
      : ({ ok: true, decoded: { image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, format: 'png' as const, sha256: 'x', byteLength: 4 } });
  };
  const { result, retryCount } = await loadWithRetry({ ref: 'irrelevant', origin: 'local-fixture' }, 5, flakyLoader as any);
  assert.equal(result.ok, true);
  assert.equal(retryCount, 2);
  assert.equal(calls, 3);
});

test('loadWithRetry retries DECODE_FAILED up to maxRetries too (a truncated fetch may succeed on retry)', async () => {
  let calls = 0;
  const flakyLoader = async () => {
    calls++;
    return calls < 2
      ? ({ ok: false, kind: 'systemError' as const, systemError: { code: 'DECODE_FAILED' as const, message: 'injected corrupt bytes', stage: 'source_acquisition' as const } })
      : ({ ok: true, decoded: { image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, format: 'webp' as const, sha256: 'y', byteLength: 4 } });
  };
  const { result, retryCount } = await loadWithRetry({ ref: 'irrelevant', origin: 'https-fetch' }, 5, flakyLoader as any);
  assert.equal(result.ok, true);
  assert.equal(retryCount, 1);
});

test('loadWithRetry gives up after maxRetries and returns the last failure', async () => {
  let calls = 0;
  const alwaysFailing = async () => {
    calls++;
    return { ok: false as const, kind: 'systemError' as const, systemError: { code: 'SOURCE_FETCH_FAILED' as const, message: 'permanently down', stage: 'source_acquisition' as const } };
  };
  const { result, retryCount } = await loadWithRetry({ ref: 'x', origin: 'local-fixture' }, 2, alwaysFailing as any);
  assert.equal(result.ok, false);
  assert.equal(retryCount, 2);
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test('loadWithRetry never retries a terminal rejection (SOURCE_TOO_SMALL)', async () => {
  let calls = 0;
  const alwaysTerminal = async () => {
    calls++;
    return { ok: false as const, kind: 'rejected' as const, rejection: { code: 'SOURCE_TOO_SMALL' as const, message: 'too small', stage: 'source_acquisition' as const } };
  };
  const { retryCount } = await loadWithRetry({ ref: 'x', origin: 'local-fixture' }, 5, alwaysTerminal as any);
  assert.equal(retryCount, 0);
  assert.equal(calls, 1);
});

test('loadWithRetry never retries UNSUPPORTED_IMAGE_FORMAT (the format will not change)', async () => {
  let calls = 0;
  const alwaysAvif = async () => {
    calls++;
    return { ok: false as const, kind: 'systemError' as const, systemError: { code: 'UNSUPPORTED_IMAGE_FORMAT' as const, message: 'AVIF', stage: 'source_acquisition' as const, format: 'AVIF' } };
  };
  const { retryCount } = await loadWithRetry({ ref: 'x', origin: 'https-fetch' }, 5, alwaysAvif as any);
  assert.equal(retryCount, 0);
  assert.equal(calls, 1);
});

// ── runIsolated: the per-item isolation mechanism itself (Gate E certification repair GATE-E-INT-002) ──

test('runIsolated returns the wrapped function\'s result unchanged when it does not throw', async () => {
  const fake = { productRef: 'p', variantId: null, variantAmbiguous: false, selectedImageRef: null, evaluatedImages: [], manifest: null, systemError: null, persistResult: null, retryCount: 0, totalDurationMs: 5 } as const;
  const result = await runIsolated({ productRef: 'p', variantId: null }, async () => fake as any);
  assert.equal(result, fake);
});

test('runIsolated converts a thrown exception into a PIPELINE_EXCEPTION systemError result instead of propagating', async () => {
  const result = await runIsolated({ productRef: 'p7', variantId: 'v2' }, async () => {
    throw new Error('injected pipeline defect');
  });
  assert.equal(result.productRef, 'p7');
  assert.equal(result.variantId, 'v2');
  assert.equal(result.manifest, null);
  assert.equal(result.systemError?.code, 'PIPELINE_EXCEPTION');
  assert.match(result.systemError!.message, /injected pipeline defect/);
});

// ── runBatch: end-to-end isolation, completeness, and idempotency ──

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
    assert.ok(result.items.every((i) => i.systemError === null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runBatch: a missing-file product is isolated (SYSTEM_ERROR:SOURCE_FETCH_FAILED) and does not affect other items', async () => {
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
    assert.equal(brokenResult.manifest, null);
    assert.equal(brokenResult.systemError?.code, 'SOURCE_FETCH_FAILED');
    const okResult = result.items.find((i) => i.productRef === synthetic.products[0].productRef)!;
    assert.equal(okResult.manifest?.rejection, null);
    assert.equal(okResult.systemError, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
  }
});

test('runBatch: a malformed product record (no productRef) becomes SYSTEM_ERROR:INVALID_INPUT without affecting other items', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-batch-'));
  const inputDir = mkdtempSync(join(tmpdir(), 'phase4-batch-input-'));
  try {
    const synthetic = generateSyntheticFixtureSet(inputDir);
    const malformed = { productRef: '', retailer: null, variantId: null, variantAuthoritative: false, category: 'top', title: null, brand: null, images: [], evidenceClass: 'SYNTHETIC' } as Phase4ProductInput;
    const result = await runBatch([synthetic.products[0], malformed], { outputRoot: dir, hintsByRef: synthetic.hintsByRef });
    assert.equal(result.items.length, 2);
    const invalid = result.items.find((i) => i.systemError?.code === 'INVALID_INPUT');
    assert.ok(invalid, 'expected an INVALID_INPUT result');
    assert.equal(invalid!.manifest, null);
    const okResult = result.items.find((i) => i.productRef === synthetic.products[0].productRef)!;
    assert.equal(okResult.systemError, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
  }
});

test('runBatch: batch-completeness invariant — input N always yields terminal result N, including a genuinely throwing item (addendum §14/§15)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-batch-'));
  const inputDir = mkdtempSync(join(tmpdir(), 'phase4-batch-input-'));
  try {
    const synthetic = generateSyntheticFixtureSet(inputDir);
    const [ok1, ok2] = synthetic.products;

    const rejects: Phase4ProductInput = {
      productRef: 'reject-too-small',
      retailer: null,
      variantId: null,
      variantAuthoritative: false,
      category: 'top',
      title: null,
      brand: null,
      // A 1x1 PNG decodes fine but is below MIN_DIMENSION — a genuine catalog rejection, not a system error.
      images: [{ ref: (() => {
        const path = join(inputDir, 'tiny.png');
        writePngFile(path, createImage(1, 1));
        return path;
      })(), origin: 'local-fixture' }],
      evidenceClass: 'SYNTHETIC',
    };

    // A malformed image ref within an otherwise-valid images array — realistic hostile input that
    // reaches loadSourceImage as `null` and throws a TypeError deep inside the real call path,
    // proving isolation works through the ACTUAL runBatch/processVariant integration, not a mock.
    const throwsDeep: Phase4ProductInput = {
      productRef: 'throws-deep',
      retailer: null,
      variantId: null,
      variantAuthoritative: false,
      category: 'top',
      title: null,
      brand: null,
      images: [null as any],
      evidenceClass: 'SYNTHETIC',
    };

    const products = [ok1, throwsDeep, rejects, ok2];
    const result = await runBatch(products, { outputRoot: dir, concurrency: 4, hintsByRef: synthetic.hintsByRef });

    assert.equal(result.items.length, products.length, 'every input item must produce exactly one terminal result');

    const byRef = new Map(result.items.map((i) => [i.productRef, i]));
    assert.equal(byRef.get(ok1.productRef)!.manifest?.rejection, null);
    assert.equal(byRef.get(ok1.productRef)!.systemError, null);
    assert.equal(byRef.get(ok2.productRef)!.manifest?.rejection, null);
    assert.equal(byRef.get(ok2.productRef)!.systemError, null);
    assert.equal(byRef.get('reject-too-small')!.manifest?.rejection?.code, 'SOURCE_TOO_SMALL');
    assert.equal(byRef.get('reject-too-small')!.systemError, null);
    assert.equal(byRef.get('throws-deep')!.manifest, null);
    assert.equal(byRef.get('throws-deep')!.systemError?.code, 'PIPELINE_EXCEPTION');

    const successCount = result.items.filter((i) => i.manifest?.eligibility.live2d === true).length;
    const rejectionCount = result.items.filter((i) => i.manifest?.rejection != null).length;
    const systemErrorCount = result.items.filter((i) => i.systemError != null).length;
    assert.equal(successCount, 2);
    assert.equal(rejectionCount, 1);
    assert.equal(systemErrorCount, 1);
    assert.equal(successCount + rejectionCount + systemErrorCount, products.length);
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

test('runBatch: idempotency holds even when a permanently-failing system-error item is present across two full re-runs (addendum §16)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-batch-'));
  const inputDir = mkdtempSync(join(tmpdir(), 'phase4-batch-input-'));
  try {
    const synthetic = generateSyntheticFixtureSet(inputDir);
    const okSubset = synthetic.products.slice(0, 2);
    const permanentlyBroken: Phase4ProductInput = {
      productRef: 'permanently-broken',
      retailer: null,
      variantId: null,
      variantAuthoritative: false,
      category: 'top',
      title: null,
      brand: null,
      images: [{ ref: join(inputDir, 'never-exists.png'), origin: 'local-fixture' }],
      evidenceClass: 'SYNTHETIC',
    };
    const products = [...okSubset, permanentlyBroken];

    const { scanExistingManifests } = await import('../src/assetStore');

    const first = await runBatch(products, { outputRoot: dir, hintsByRef: synthetic.hintsByRef, maxRetries: 0 });
    const afterFirst = scanExistingManifests(dir).length;
    assert.equal(first.items.find((i) => i.productRef === 'permanently-broken')!.systemError?.code, 'SOURCE_FETCH_FAILED');

    const second = await runBatch(products, { outputRoot: dir, hintsByRef: synthetic.hintsByRef, maxRetries: 0 });
    const afterSecond = scanExistingManifests(dir).length;

    assert.equal(afterFirst, afterSecond, 'the successful siblings must not gain duplicate asset directories across re-runs, even with a permanently-erroring cohort member present');
    assert.equal(second.items.length, products.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
  }
});
