import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deformVertex, deformMesh, gridVertices, type ControlPointPair, type Vec2 } from '../affineMlsDeformation';

function approxEqual(a: Vec2, b: Vec2, eps = 1e-6) {
  assert.ok(Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps, `expected ${JSON.stringify(a)} ~= ${JSON.stringify(b)}`);
}

const SQUARE_CONTROL_POINTS: ControlPointPair[] = [
  { source: { x: 0, y: 0 }, target: { x: 0.1, y: 0.05 } },
  { source: { x: 1, y: 0 }, target: { x: 1.05, y: 0.02 } },
  { source: { x: 1, y: 1 }, target: { x: 0.95, y: 0.9 } },
  { source: { x: 0, y: 1 }, target: { x: -0.02, y: 0.88 } },
];

test('deformVertex: exact interpolation at a control point source', () => {
  for (const cp of SQUARE_CONTROL_POINTS) {
    approxEqual(deformVertex(cp.source, SQUARE_CONTROL_POINTS), cp.target, 1e-9);
  }
});

test('deformVertex: no control points is the identity', () => {
  approxEqual(deformVertex({ x: 0.3, y: 0.7 }, []), { x: 0.3, y: 0.7 });
});

test('deformVertex: single control point is a pure translation', () => {
  const cps: ControlPointPair[] = [{ source: { x: 2, y: 3 }, target: { x: 5, y: 1 } }];
  // translation = target - source = (3, -2)
  approxEqual(deformVertex({ x: 10, y: 10 }, cps), { x: 13, y: 8 });
});

test('deformVertex: uniform translation of every control point translates every query vertex identically', () => {
  const t: Vec2 = { x: 0.2, y: -0.15 };
  const cps: ControlPointPair[] = SQUARE_CONTROL_POINTS.map((cp) => ({
    source: cp.source,
    target: { x: cp.source.x + t.x, y: cp.source.y + t.y },
  }));

  for (const v of [{ x: 0.5, y: 0.5 }, { x: -3, y: 7 }, { x: 0, y: 0 }, { x: 100, y: -50 }]) {
    approxEqual(deformVertex(v, cps), { x: v.x + t.x, y: v.y + t.y }, 1e-6);
  }
});

test('deformVertex: uniform scaling about the origin maps every query vertex to exactly k*v', () => {
  // Asymmetric, non-square control points so this isn't passing by symmetry accident.
  const k = 2.4;
  const sources: Vec2[] = [
    { x: 1, y: 0.2 },
    { x: -0.5, y: 3 },
    { x: 4, y: -1 },
    { x: -2, y: -2 },
    { x: 0.3, y: 1.7 },
  ];
  const cps: ControlPointPair[] = sources.map((s) => ({ source: s, target: { x: s.x * k, y: s.y * k } }));

  for (const v of [{ x: 1, y: 1 }, { x: -5, y: 2 }, { x: 0, y: 0 }, { x: 10, y: -10 }]) {
    approxEqual(deformVertex(v, cps), { x: v.x * k, y: v.y * k }, 1e-6);
  }
});

test('deformVertex: degenerate collinear control points do not produce NaN/Infinity', () => {
  const cps: ControlPointPair[] = [
    { source: { x: 0, y: 0 }, target: { x: 0.1, y: 0 } },
    { source: { x: 1, y: 0 }, target: { x: 1.2, y: 0 } },
    { source: { x: 2, y: 0 }, target: { x: 2.4, y: 0 } },
  ];
  const result = deformVertex({ x: 0.5, y: 5 }, cps);
  assert.ok(Number.isFinite(result.x));
  assert.ok(Number.isFinite(result.y));
});

test('gridVertices produces width*height vertices spanning [0,1]x[0,1]', () => {
  const vertices = gridVertices(4, 3);
  assert.equal(vertices.length, 12);
  assert.deepEqual(vertices[0], { x: 0, y: 0 });
  assert.deepEqual(vertices[vertices.length - 1], { x: 1, y: 1 });
});

test('deformMesh maps every vertex consistently with deformVertex', () => {
  const vertices = gridVertices(2, 2);
  const deformed = deformMesh(vertices, SQUARE_CONTROL_POINTS);
  assert.equal(deformed.length, vertices.length);
  vertices.forEach((v, i) => {
    approxEqual(deformed[i]!, deformVertex(v, SQUARE_CONTROL_POINTS));
  });
});
