import Foundation

/// Affine moving-least-squares mesh deformation.
///
/// Field-for-field port of Android's `LiveVtoDeformation.kt`, itself a
/// line-for-line port of the reference implementation
/// `@kscan-live-vto/asset-pipeline` `affineMlsDeformation.deformVertex`, read
/// from its compiled output at reference SHA `e7c5d72` (this port's pin --
/// see `docs/vto-live-bridge-contract.md`).
///
/// This is affine MLS, not the rigid variant from Schaefer et al. 2006: rigid
/// MLS's closed form involves a perpendicular-vector construction whose
/// sign/transpose conventions are easy to get subtly wrong, and a
/// subtly-wrong deformation looks plausible while being incorrect. Affine MLS
/// is weighted least-squares linear regression with a directly verifiable
/// closed form. If the reference switches to rigid MLS, this must follow it,
/// and the goldens will say so -- this reasoning is inherited, not
/// re-litigated.
public enum LiveVtoDeformation {

  private static let epsilon = 1e-9

  /// A (source in texture-pixel space, target in body/canvas space) correspondence.
  public struct ControlPointPair {
    public let source: Vec2
    public let target: Vec2
    public init(source: Vec2, target: Vec2) {
      self.source = source
      self.target = target
    }
  }

  private struct Mat2 {
    let a: Double, b: Double, c: Double, d: Double
  }

  private static func invert2x2(_ m: Mat2) -> Mat2 {
    let det = m.a * m.d - m.b * m.c
    if abs(det) < epsilon {
      // Degenerate (e.g. all control points collinear in source space) --
      // fall back to identity rather than dividing by ~0 and producing a
      // wild extrapolation.
      return Mat2(a: 1, b: 0, c: 0, d: 1)
    }
    let invDet = 1.0 / det
    return Mat2(a: m.d * invDet, b: -m.b * invDet, c: -m.c * invDet, d: m.a * invDet)
  }

  /// Deforms one query vertex.
  ///
  /// Computed in Double, not Float. The normal equations accumulate products
  /// of coordinates of order 10^2 weighted by 1/distance^2, so the
  /// intermediate magnitudes span many orders of magnitude and Float32 loses
  /// meaningful precision in `S` before it is inverted. The result is
  /// narrowed to Float only at the end, where it is a coordinate again.
  public static func deformVertex(_ v: Vec2, _ controlPoints: [ControlPointPair]) -> Vec2 {
    if controlPoints.isEmpty { return v }

    // Exact interpolation at a control point: the w_i -> infinity limit,
    // handled explicitly as the MLS family requires.
    for cp in controlPoints {
      let dx = Double(cp.source.x - v.x)
      let dy = Double(cp.source.y - v.y)
      if dx * dx + dy * dy < epsilon { return cp.target }
    }

    if controlPoints.count == 1 {
      let cp = controlPoints[0]
      return Vec2(v.x - cp.source.x + cp.target.x, v.y - cp.source.y + cp.target.y)
    }

    var weights = [Double](repeating: 0, count: controlPoints.count)
    for i in controlPoints.indices {
      let dx = Double(controlPoints[i].source.x - v.x)
      let dy = Double(controlPoints[i].source.y - v.y)
      weights[i] = 1.0 / (dx * dx + dy * dy)
    }
    let weightSum = weights.reduce(0, +)

    var pStarX = 0.0, pStarY = 0.0, qStarX = 0.0, qStarY = 0.0
    for i in controlPoints.indices {
      let w = weights[i] / weightSum
      pStarX += w * Double(controlPoints[i].source.x)
      pStarY += w * Double(controlPoints[i].source.y)
      qStarX += w * Double(controlPoints[i].target.x)
      qStarY += w * Double(controlPoints[i].target.y)
    }

    // S = sum w_i * p_hat_i^T p_hat_i  (2x2, symmetric)
    // T = sum w_i * p_hat_i^T q_hat_i  (2x2)
    var sxx = 0.0, sxy = 0.0, syy = 0.0
    var txx = 0.0, txy = 0.0, tyx = 0.0, tyy = 0.0
    for i in controlPoints.indices {
      let w = weights[i]
      let px = Double(controlPoints[i].source.x) - pStarX
      let py = Double(controlPoints[i].source.y) - pStarY
      let qx = Double(controlPoints[i].target.x) - qStarX
      let qy = Double(controlPoints[i].target.y) - qStarY
      sxx += w * px * px
      sxy += w * px * py
      syy += w * py * py
      txx += w * px * qx
      txy += w * px * qy
      tyx += w * py * qx
      tyy += w * py * qy
    }

    let sInv = invert2x2(Mat2(a: sxx, b: sxy, c: sxy, d: syy))

    // M = S^-1 * T, solving (v - p*) M ~= (q - q*) in the least-squares sense.
    let mxx = sInv.a * txx + sInv.b * tyx
    let mxy = sInv.a * txy + sInv.b * tyy
    let myx = sInv.c * txx + sInv.d * tyx
    let myy = sInv.c * txy + sInv.d * tyy

    let vx = Double(v.x) - pStarX
    let vy = Double(v.y) - pStarY
    return Vec2(
      Float(vx * mxx + vy * myx + qStarX),
      Float(vx * mxy + vy * myy + qStarY))
  }

  /// The grid mesh's SOURCE vertices, in texture-pixel space.
  ///
  /// `meshDefinition.width`/`height` are VERTEX counts, not cell counts -- the
  /// reference's `buildGridMesh` divides by `columns - 1`. Getting this wrong
  /// changes both the vertex count and where every sample sits.
  public static func gridSourceVertices(_ mesh: MeshDefinition, textureWidth: Int, textureHeight: Int) -> [Vec2] {
    let columns = mesh.width
    let rows = mesh.height
    var out: [Vec2] = []
    out.reserveCapacity(columns * rows)
    for row in 0..<rows {
      for col in 0..<columns {
        out.append(Vec2(
          columns == 1 ? 0 : (Float(col) / Float(columns - 1)) * Float(textureWidth),
          rows == 1 ? 0 : (Float(row) / Float(rows - 1)) * Float(textureHeight)))
      }
    }
    return out
  }

  /// Builds the flattened vertex array a `CGPath`/mesh renderer consumes.
  ///
  /// Android's `Canvas.drawBitmapMesh(bitmap, meshWidth, meshHeight, verts,
  /// ...)` takes CELL counts and requires `(meshWidth + 1) * (meshHeight + 1)`
  /// vertices in row-major order -- exactly the manifest's (vertexColumns x
  /// vertexRows) grid with meshWidth = columns - 1 and meshHeight = rows - 1.
  /// The iOS renderer (`LiveVtoRenderView`) reshapes this same flattened,
  /// row-major (x,y) layout into whatever triangle list its own drawing
  /// primitive needs -- the deformation output format itself is renderer-
  /// agnostic and kept identical across platforms for conformance.
  public static func buildDeformedMesh(
    manifest: KsgarmentManifest, targets: [GarmentControlPointId: Vec2], textureWidth: Int, textureHeight: Int
  ) -> [Float] {
    let pairs: [ControlPointPair] = manifest.controlPoints.compactMap { cp in
      guard let target = targets[cp.id] else { return nil }
      return ControlPointPair(source: Vec2(cp.u * Float(textureWidth), cp.v * Float(textureHeight)), target: target)
    }
    let source = gridSourceVertices(manifest.meshDefinition, textureWidth: textureWidth, textureHeight: textureHeight)
    var verts = [Float](repeating: 0, count: source.count * 2)
    for i in source.indices {
      let deformed = deformVertex(source[i], pairs)
      verts[i * 2] = deformed.x
      verts[i * 2 + 1] = deformed.y
    }
    return verts
  }
}
