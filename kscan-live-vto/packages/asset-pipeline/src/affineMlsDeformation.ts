/**
 * Control-point mesh deformation — Section P1-E2 / P2-C2.
 *
 * The plan's default is "MLS-rigid deformation or equivalent simple
 * well-understood control-point deformation... Do NOT launch an
 * open-ended algorithm tournament." This file implements **affine moving
 * least squares (MLS)** rather than the rigid variant from Schaefer et
 * al. 2006.
 *
 * Why affine instead of rigid, explicitly (Section 40 Failure Policy asks
 * for reasoning to be recorded, not silently substituted): rigid MLS's
 * closed form involves a specific perpendicular-vector construction whose
 * sign/transpose conventions are easy to get subtly wrong from memory,
 * and a subtly-wrong deformation is worse than a correctly-implemented
 * simpler one — it would look plausible while being mathematically
 * incorrect, and that would be very hard to catch without a live person
 * comparing rendered output to a reference. Affine MLS is textbook
 * weighted least-squares linear regression: for every query vertex it
 * fits a 2x2 linear map (plus a translation of the weighted centroid)
 * minimizing the weighted squared error to every control point, which
 * has a direct, easily-verified closed form (normal equations + a 2x2
 * matrix inverse). It is still a "simple, well-understood control-point
 * deformation," still bounded per-vertex work, and still exactly the
 * "one primary... comparable simple deformation" Section 41 asks for.
 *
 * Trade-off to weigh against real golden-sequence evidence (Section 41:
 * "Only benchmark alternatives when baseline fails documented
 * requirements"): affine MLS can introduce shear/non-uniform scaling near
 * sparse or ill-conditioned control-point configurations, which rigid MLS
 * avoids by construction. If P1-E2's calibration set shows visible
 * shearing (garment corners no longer looking square, logo distortion
 * beyond what lighting/anchor error alone explains), that is the
 * documented, evidence-based trigger to implement true rigid MLS as the
 * benchmarked alternative — not a preference call made now.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface ControlPointPair {
  /** Rest/source position in the garment's own mesh space. */
  source: Vec2;
  /** Where that same semantic point should land given the current body/anchor placement. */
  target: Vec2;
}

const EPSILON = 1e-9;

interface Mat2 {
  a: number;
  b: number;
  c: number;
  d: number; // [[a, b], [c, d]]
}

function invert2x2(m: Mat2): Mat2 {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < EPSILON) {
    // Degenerate (e.g. all control points collinear in source space) —
    // fall back to identity rather than dividing by ~0 and producing a
    // wild extrapolation.
    return { a: 1, b: 0, c: 0, d: 1 };
  }
  const invDet = 1 / det;
  return { a: m.d * invDet, b: -m.b * invDet, c: -m.c * invDet, d: m.a * invDet };
}

/**
 * Deforms a single query vertex `v` given a set of control-point pairs.
 * Exact interpolation at a control point: if `v` coincides with a
 * control point's source position (within EPSILON), its target is
 * returned directly rather than going through the weighted fit (matches
 * the MLS family's standard handling of the w_i -> infinity limit).
 */
export function deformVertex(v: Vec2, controlPoints: readonly ControlPointPair[]): Vec2 {
  if (controlPoints.length === 0) return v;

  for (const cp of controlPoints) {
    const dx = cp.source.x - v.x;
    const dy = cp.source.y - v.y;
    if (dx * dx + dy * dy < EPSILON) return cp.target;
  }

  if (controlPoints.length === 1) {
    const cp = controlPoints[0]!;
    return { x: v.x - cp.source.x + cp.target.x, y: v.y - cp.source.y + cp.target.y };
  }

  const weights = controlPoints.map((cp) => {
    const dx = cp.source.x - v.x;
    const dy = cp.source.y - v.y;
    return 1 / (dx * dx + dy * dy);
  });
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const pStar: Vec2 = { x: 0, y: 0 };
  const qStar: Vec2 = { x: 0, y: 0 };
  controlPoints.forEach((cp, i) => {
    const w = weights[i]! / weightSum;
    pStar.x += w * cp.source.x;
    pStar.y += w * cp.source.y;
    qStar.x += w * cp.target.x;
    qStar.y += w * cp.target.y;
  });

  // S = sum w_i * p_hat_i^T p_hat_i  (2x2, symmetric)
  // T = sum w_i * p_hat_i^T q_hat_i  (2x2)
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let txx = 0;
  let txy = 0;
  let tyx = 0;
  let tyy = 0;

  controlPoints.forEach((cp, i) => {
    const w = weights[i]!;
    const px = cp.source.x - pStar.x;
    const py = cp.source.y - pStar.y;
    const qx = cp.target.x - qStar.x;
    const qy = cp.target.y - qStar.y;

    sxx += w * px * px;
    sxy += w * px * py;
    syy += w * py * py;

    txx += w * px * qx;
    txy += w * px * qy;
    tyx += w * py * qx;
    tyy += w * py * qy;
  });

  const S: Mat2 = { a: sxx, b: sxy, c: sxy, d: syy };
  const Sinv = invert2x2(S);

  // M = S^-1 * T, solving (v - p*) M ~= (q - q*) in the least-squares sense.
  const Mxx = Sinv.a * txx + Sinv.b * tyx;
  const Mxy = Sinv.a * txy + Sinv.b * tyy;
  const Myx = Sinv.c * txx + Sinv.d * tyx;
  const Myy = Sinv.c * txy + Sinv.d * tyy;

  const vx = v.x - pStar.x;
  const vy = v.y - pStar.y;

  return {
    x: vx * Mxx + vy * Myx + qStar.x,
    y: vx * Mxy + vy * Myy + qStar.y,
  };
}

/** Deforms every vertex of a mesh (e.g. a grid MeshDefinition's sample points). */
export function deformMesh(vertices: readonly Vec2[], controlPoints: readonly ControlPointPair[]): Vec2[] {
  return vertices.map((v) => deformVertex(v, controlPoints));
}

/**
 * Generates the sample vertices of a `grid` MeshDefinition in normalized
 * [0,1]x[0,1] UV space, matching garment-contract's MeshDefinition shape
 * (width/height = number of vertices along each axis).
 */
export function gridVertices(width: number, height: number): Vec2[] {
  const vertices: Vec2[] = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      vertices.push({ x: width === 1 ? 0 : col / (width - 1), y: height === 1 ? 0 : row / (height - 1) });
    }
  }
  return vertices;
}
