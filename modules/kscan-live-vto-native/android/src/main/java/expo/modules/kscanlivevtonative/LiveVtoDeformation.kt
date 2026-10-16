package expo.modules.kscanlivevtonative

import kotlin.math.abs

/**
 * Affine moving-least-squares mesh deformation.
 *
 * Line-for-line port of the reference implementation
 * `@kscan-live-vto/asset-pipeline` `affineMlsDeformation.deformVertex`,
 * read from its COMPILED output (`dist/affineMlsDeformation.js`) at
 * reference SHA `266ab1a` — per amendment D5 and the lesson of N1-ENV-006,
 * the arithmetic is only in the compiled source, never in the `.d.ts`.
 *
 * This replaces the inverse-distance-weighted placeholder N1-B shipped and
 * labelled as a known simplification. See N1-ENV-010: the placeholder made
 * control-point-exact geometry that did not read as a garment between the
 * control points, which is exactly what a numbers-only gate cannot catch.
 *
 * The reference deliberately uses AFFINE MLS rather than the rigid variant
 * from Schaefer et al. 2006, and records why: rigid MLS's closed form
 * involves a perpendicular-vector construction whose sign and transpose
 * conventions are easy to get subtly wrong, and a subtly-wrong deformation
 * looks plausible while being incorrect. Affine MLS is weighted
 * least-squares linear regression with a directly verifiable closed form.
 * That reasoning is inherited here rather than re-litigated; if the
 * reference switches to rigid MLS, this must follow it, and the goldens
 * will say so.
 */
object LiveVtoDeformation {

  private const val EPSILON = 1e-9

  /** A (source in texture-pixel space, target in body/canvas space) correspondence. */
  data class ControlPointPair(val source: Vec2, val target: Vec2)

  private data class Mat2(val a: Double, val b: Double, val c: Double, val d: Double)

  private fun invert2x2(m: Mat2): Mat2 {
    val det = m.a * m.d - m.b * m.c
    if (abs(det) < EPSILON) {
      // Degenerate (e.g. all control points collinear in source space) --
      // fall back to identity rather than dividing by ~0 and producing a
      // wild extrapolation.
      return Mat2(1.0, 0.0, 0.0, 1.0)
    }
    val invDet = 1.0 / det
    return Mat2(m.d * invDet, -m.b * invDet, -m.c * invDet, m.a * invDet)
  }

  /**
   * Deforms one query vertex.
   *
   * Computed in Double, not Float. The normal equations accumulate products
   * of coordinates of order 10^2 weighted by 1/distance^2, so the
   * intermediate magnitudes span many orders of magnitude and float32 loses
   * meaningful precision in `S` before it is inverted. The result is
   * narrowed to Float only at the end, where it is a coordinate again.
   */
  fun deformVertex(v: Vec2, controlPoints: List<ControlPointPair>): Vec2 {
    if (controlPoints.isEmpty()) return v

    // Exact interpolation at a control point: the w_i -> infinity limit,
    // handled explicitly as the MLS family requires.
    for (cp in controlPoints) {
      val dx = (cp.source.x - v.x).toDouble()
      val dy = (cp.source.y - v.y).toDouble()
      if (dx * dx + dy * dy < EPSILON) return cp.target
    }

    if (controlPoints.size == 1) {
      val cp = controlPoints[0]
      return Vec2(v.x - cp.source.x + cp.target.x, v.y - cp.source.y + cp.target.y)
    }

    val weights = DoubleArray(controlPoints.size)
    for (i in controlPoints.indices) {
      val dx = (controlPoints[i].source.x - v.x).toDouble()
      val dy = (controlPoints[i].source.y - v.y).toDouble()
      weights[i] = 1.0 / (dx * dx + dy * dy)
    }
    val weightSum = weights.sum()

    var pStarX = 0.0; var pStarY = 0.0
    var qStarX = 0.0; var qStarY = 0.0
    for (i in controlPoints.indices) {
      val w = weights[i] / weightSum
      pStarX += w * controlPoints[i].source.x
      pStarY += w * controlPoints[i].source.y
      qStarX += w * controlPoints[i].target.x
      qStarY += w * controlPoints[i].target.y
    }

    // S = sum w_i * p_hat_i^T p_hat_i  (2x2, symmetric)
    // T = sum w_i * p_hat_i^T q_hat_i  (2x2)
    var sxx = 0.0; var sxy = 0.0; var syy = 0.0
    var txx = 0.0; var txy = 0.0; var tyx = 0.0; var tyy = 0.0
    for (i in controlPoints.indices) {
      val w = weights[i]
      val px = controlPoints[i].source.x - pStarX
      val py = controlPoints[i].source.y - pStarY
      val qx = controlPoints[i].target.x - qStarX
      val qy = controlPoints[i].target.y - qStarY
      sxx += w * px * px
      sxy += w * px * py
      syy += w * py * py
      txx += w * px * qx
      txy += w * px * qy
      tyx += w * py * qx
      tyy += w * py * qy
    }

    val sInv = invert2x2(Mat2(sxx, sxy, sxy, syy))

    // M = S^-1 * T, solving (v - p*) M ~= (q - q*) in the least-squares sense.
    val mxx = sInv.a * txx + sInv.b * tyx
    val mxy = sInv.a * txy + sInv.b * tyy
    val myx = sInv.c * txx + sInv.d * tyx
    val myy = sInv.c * txy + sInv.d * tyy

    val vx = v.x - pStarX
    val vy = v.y - pStarY
    return Vec2(
      (vx * mxx + vy * myx + qStarX).toFloat(),
      (vx * mxy + vy * myy + qStarY).toFloat(),
    )
  }

  /**
   * The grid mesh's SOURCE vertices, in texture-pixel space.
   *
   * `meshDefinition.width`/`height` are VERTEX counts, not cell counts --
   * the reference's `buildGridMesh` divides by `columns - 1`. Getting this
   * wrong changes both the vertex count and where every sample sits; see
   * N1-ENV-011.
   */
  fun gridSourceVertices(mesh: MeshDefinition, textureWidth: Int, textureHeight: Int): List<Vec2> {
    val columns = mesh.width
    val rows = mesh.height
    val out = ArrayList<Vec2>(columns * rows)
    for (row in 0 until rows) {
      for (col in 0 until columns) {
        out.add(
          Vec2(
            if (columns == 1) 0f else (col.toFloat() / (columns - 1)) * textureWidth,
            if (rows == 1) 0f else (row.toFloat() / (rows - 1)) * textureHeight,
          )
        )
      }
    }
    return out
  }

  /**
   * Builds the flattened vertex array `Canvas.drawBitmapMesh` consumes.
   *
   * Android's `drawBitmapMesh(bitmap, meshWidth, meshHeight, verts, ...)`
   * takes CELL counts and requires `(meshWidth + 1) * (meshHeight + 1)`
   * vertices in row-major order -- which is exactly the manifest's
   * (vertexColumns x vertexRows) grid with meshWidth = columns - 1 and
   * meshHeight = rows - 1. The two conventions line up only once the
   * vertex/cell distinction is right.
   */
  fun buildDeformedMesh(
    manifest: KsgarmentManifest,
    targets: Map<GarmentControlPointId, Vec2>,
    textureWidth: Int,
    textureHeight: Int,
  ): FloatArray {
    val pairs = manifest.controlPoints.mapNotNull { cp ->
      targets[cp.id]?.let {
        ControlPointPair(Vec2(cp.u * textureWidth, cp.v * textureHeight), it)
      }
    }
    val source = gridSourceVertices(manifest.meshDefinition, textureWidth, textureHeight)
    val verts = FloatArray(source.size * 2)
    for (i in source.indices) {
      val deformed = deformVertex(source[i], pairs)
      verts[i * 2] = deformed.x
      verts[i * 2 + 1] = deformed.y
    }
    return verts
  }
}
