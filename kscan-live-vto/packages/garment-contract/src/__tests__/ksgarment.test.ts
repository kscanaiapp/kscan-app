import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KSGARMENT_SCHEMA_VERSION,
  validateKsgarmentManifest,
  type KsgarmentManifest,
} from '../ksgarment';

function validManifest(): KsgarmentManifest {
  return {
    version: KSGARMENT_SCHEMA_VERSION,
    productId: 'fixture-shirt-001',
    category: 'Tops',
    subcategory: 'crew-neck',
    silhouette: 'regular',
    sleeveLength: 'short',
    garmentLength: 'hip',
    neckline: 'crew',
    controlPoints: [
      { id: 'leftShoulder', u: 0.2, v: 0.1 },
      { id: 'rightShoulder', u: 0.8, v: 0.1 },
      { id: 'leftHem', u: 0.2, v: 0.9 },
      { id: 'rightHem', u: 0.8, v: 0.9 },
    ],
    meshDefinition: { type: 'grid', width: 32, height: 48 },
    texture: 'texture.png',
    alphaMask: 'alpha.png',
    assetVersion: '1',
  };
}

test('validateKsgarmentManifest accepts a well-formed manifest', () => {
  const result = validateKsgarmentManifest(validManifest());
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test('validateKsgarmentManifest rejects a non-object', () => {
  const result = validateKsgarmentManifest('not an object');
  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 1);
});

test('validateKsgarmentManifest rejects a wrong schema version', () => {
  const manifest = { ...validManifest(), version: '0.9' };
  const result = validateKsgarmentManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === 'version'));
});

test('validateKsgarmentManifest rejects out-of-range control point coordinates', () => {
  const manifest = validManifest();
  manifest.controlPoints[0] = { id: 'leftShoulder', u: 1.5, v: 0.1 };
  const result = validateKsgarmentManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === 'controlPoints[0].u'));
});

test('validateKsgarmentManifest requires the P1-E1 minimum control points', () => {
  const manifest = validManifest();
  manifest.controlPoints = [{ id: 'leftShoulder', u: 0.2, v: 0.1 }];
  const result = validateKsgarmentManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('rightShoulder')));
  assert.ok(result.issues.some((i) => i.message.includes('leftHem')));
  assert.ok(result.issues.some((i) => i.message.includes('rightHem')));
});

test('validateKsgarmentManifest rejects an unrecognized control point id', () => {
  const manifest = validManifest();
  manifest.controlPoints.push({ id: 'elbowPatch' as any, u: 0.5, v: 0.5 });
  const result = validateKsgarmentManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === 'controlPoints[4].id'));
});

test('validateKsgarmentManifest rejects an unsupported mesh type', () => {
  const manifest = { ...validManifest(), meshDefinition: { type: 'nurbs', width: 4, height: 4 } as any };
  const result = validateKsgarmentManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === 'meshDefinition.type'));
});
