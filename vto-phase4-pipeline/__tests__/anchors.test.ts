import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAnchors, requiredAnchorsPresent, toControlPoints } from '../src/anchors';
import { segmentGarment } from '../src/segmentation';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import { validateKsgarmentManifest } from '../src/garmentContract';
import { buildKsgarmentManifest } from '../src/manifestBuilder';
import { buildMeshDefinition } from '../src/mesh';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

test('generateAnchors derives all four minimum-required control points from a clean garment mask', () => {
  const { image } = generateSyntheticGarment({ seed: 1, backgroundColor: WHITE, garmentColor: BLUE });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const candidates = generateAnchors(seg.alphaMask);
  assert.ok(requiredAnchorsPresent(candidates), 'expected leftShoulder/rightShoulder/leftHem/rightHem to be derivable');

  const shoulder = candidates.find((c) => c.point.id === 'leftShoulder')!;
  const hem = candidates.find((c) => c.point.id === 'leftHem')!;
  assert.ok(shoulder.point.v < hem.point.v, 'shoulder should be above hem in v-coordinate');
});

test('generateAnchors + buildKsgarmentManifest produces a manifest that validates against the .ksgarment contract', () => {
  const { image } = generateSyntheticGarment({ seed: 2, backgroundColor: WHITE, garmentColor: BLUE });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const candidates = generateAnchors(seg.alphaMask);
  const manifest = buildKsgarmentManifest({
    productId: 'test-product',
    category: 'top',
    controlPoints: toControlPoints(candidates),
    meshDefinition: buildMeshDefinition(),
    assetVersion: '1',
  });
  const validation = validateKsgarmentManifest(manifest);
  assert.equal(validation.valid, true, validation.errors.join('; '));
});

test('generateAnchors returns [] for a mask with too few valid rows (degenerate input)', () => {
  const seg = segmentGarment(generateSyntheticGarment({ seed: 3, backgroundColor: WHITE, garmentColor: BLUE }).image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  // Truncate the alpha mask to 2 rows to simulate a degenerate crop.
  const tiny = { width: seg.alphaMask.width, height: 2, data: seg.alphaMask.data.slice(0, seg.alphaMask.width * 2 * 4) };
  const candidates = generateAnchors(tiny as any);
  assert.equal(candidates.length, 0);
});
