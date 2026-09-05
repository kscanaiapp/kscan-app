import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistAsset, scanExistingManifests } from '../src/assetStore';
import { computeAssetId } from '../src/manifestBuilder';
import type { Phase4AssetManifest } from '../src/types';

function makeManifest(overrides: Partial<Phase4AssetManifest> = {}): Phase4AssetManifest {
  const sourceSha256 = overrides.source?.sha256 ?? 'sha-a';
  return {
    assetId: computeAssetId('product-1', null, sourceSha256),
    pipelineVersion: '0.1.0',
    contractVersion: '1.0',
    assetVersion: '1',
    generatedAt: new Date().toISOString(),
    evidenceClass: 'SYNTHETIC',
    productIdentity: { productRef: 'product-1', retailer: null, variantId: null, category: 'top' },
    source: { ref: 'x', sha256: sourceSha256, width: 10, height: 10, format: 'png' },
    shotClassification: { shotClass: 'EASY', confidence: 1, evidence: {} },
    confidenceComponents: { shotClassification: 1, segmentation: 1, anchorCompleteness: 1, geometryValidity: 1, sourceQuality: 1, productFidelity: 1 },
    qa: null,
    eligibility: { live2d: true, live3d: false, reason: null },
    status: 'CURRENT',
    rejection: null,
    ksgarment: null,
    anchorEvidence: [],
    correctionHistory: [],
    stageTimings: [],
    sourceAdequacy: { classification: 'UNKNOWN', sourceWidth: 10, sourceHeight: 10, shortSidePx: 10, longSidePx: 10, garmentBoundingWidthPx: null, garmentBoundingHeightPx: null, garmentOccupancyRatio: null, reason: 'test fixture' },
    ...overrides,
  };
}

test('persistAsset: re-persisting the identical asset is idempotent (no duplicate, skipped write)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-store-'));
  try {
    const manifest = makeManifest();
    const first = persistAsset(dir, manifest, null, null);
    assert.equal(first.written, true);
    assert.equal(first.skippedIdempotent, false);

    const second = persistAsset(dir, manifest, null, null);
    assert.equal(second.written, false);
    assert.equal(second.skippedIdempotent, true);

    const all = scanExistingManifests(dir);
    assert.equal(all.length, 1, 'idempotent re-run must not create a duplicate asset directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistAsset: a new source image for the same product marks the prior asset STALE, never leaves it silently current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-store-'));
  try {
    const first = makeManifest({ source: { ref: 'x', sha256: 'sha-a', width: 10, height: 10, format: 'png' } });
    persistAsset(dir, first, null, null);

    const second = makeManifest({ source: { ref: 'x', sha256: 'sha-b', width: 10, height: 10, format: 'png' } });
    second.assetId = computeAssetId('product-1', null, 'sha-b');
    const result = persistAsset(dir, second, null, null);

    assert.equal(result.written, true);
    assert.deepEqual(result.staleMarked, [first.assetId]);

    const all = scanExistingManifests(dir);
    const oldOne = all.find((m) => m.assetId === first.assetId)!;
    const newOne = all.find((m) => m.assetId === second.assetId)!;
    assert.equal(oldOne.status, 'STALE');
    assert.equal(newOne.status, 'CURRENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeAssetId: deterministic for identical inputs, different for any changed component', () => {
  const a = computeAssetId('product-1', null, 'sha-a');
  const b = computeAssetId('product-1', null, 'sha-a');
  const c = computeAssetId('product-1', 'variant-x', 'sha-a');
  const d = computeAssetId('product-1', null, 'sha-b');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});
