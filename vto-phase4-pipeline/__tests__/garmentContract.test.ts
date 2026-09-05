import test from 'node:test';
import assert from 'node:assert/strict';
import { KSGARMENT_SCHEMA_VERSION, MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT, validateKsgarmentManifest } from '../src/garmentContract';

function validManifest() {
  return {
    version: KSGARMENT_SCHEMA_VERSION,
    productId: 'p1',
    category: 'top',
    subcategory: 'unknown',
    silhouette: 'unknown',
    sleeveLength: 'unknown',
    garmentLength: 'unknown',
    neckline: 'unknown',
    controlPoints: MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT.map((id) => ({ id, u: 0.5, v: 0.5 })),
    meshDefinition: { type: 'grid', width: 8, height: 10 },
    texture: 'texture.png',
    alphaMask: 'alpha.png',
    assetVersion: '1',
  };
}

test('validateKsgarmentManifest accepts a well-formed manifest', () => {
  const result = validateKsgarmentManifest(validManifest());
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('validateKsgarmentManifest rejects a wrong schema version', () => {
  const m = { ...validManifest(), version: '2.0' };
  const result = validateKsgarmentManifest(m);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('version')));
});

test('validateKsgarmentManifest rejects a manifest missing a required control point', () => {
  const m = validManifest();
  m.controlPoints = m.controlPoints.filter((cp) => cp.id !== 'leftHem');
  const result = validateKsgarmentManifest(m);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('leftHem')));
});

test('validateKsgarmentManifest rejects an out-of-range control point coordinate', () => {
  const m = validManifest();
  m.controlPoints[0] = { ...m.controlPoints[0], u: 1.5 };
  const result = validateKsgarmentManifest(m);
  assert.equal(result.valid, false);
});

test('validateKsgarmentManifest rejects a non-grid mesh type', () => {
  const m = { ...validManifest(), meshDefinition: { type: 'other', width: 1, height: 1 } as any };
  const result = validateKsgarmentManifest(m);
  assert.equal(result.valid, false);
});

test('validateKsgarmentManifest rejects a non-object input without throwing', () => {
  assert.equal(validateKsgarmentManifest(null).valid, false);
  assert.equal(validateKsgarmentManifest('nope').valid, false);
  assert.equal(validateKsgarmentManifest(undefined).valid, false);
});
