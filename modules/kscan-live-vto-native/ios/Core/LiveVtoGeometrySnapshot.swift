import Foundation

/// The computed geometry for one (garment, BodyFrame) pair, BEFORE any
/// rasterization. Field-for-field port of Android's `LiveVtoGeometrySnapshot.kt`.
///
/// Conformance is measured on THIS, not on screenshots. A screenshot proves
/// a garment-shaped thing appeared; only the numbers prove it appeared in the
/// same place the P3-A reference oracle puts it. `LiveVtoGeometryPipeline.compute`
/// is the single code path that produces one, and it is the same path
/// `LiveVtoRenderView` draws from -- a snapshot can never describe state the
/// renderer did not actually receive.
///
/// Immutable by construction: `controlPoints`/`meshVertices` are plain Swift
/// value types (`Dictionary`/`Array`), so unlike Kotlin's `data class` (which
/// needed a manual identity-based `equals`/`hashCode` override to avoid
/// `FloatArray`'s reference-equality default), `Equatable` here is correct
/// out of the box: two snapshots with the same field values really are equal.
public struct GeometrySnapshot: Equatable {
  public let fixtureId: String
  public let bodyFrameId: String
  public let activeAssetId: String
  public let assetVersion: String
  /// Body-space canvas-pixel target for every control point the manifest declares, keyed by control point id string.
  public let controlPoints: [String: Vec2]
  public let boundsMin: Vec2
  public let boundsMax: Vec2
  public let scale: Float
  public let rotationRadians: Float
  public let gatePassed: Bool
  public let gateFindings: [String]
  public let canvasWidth: Float
  public let canvasHeight: Float
  public let textureWidth: Int
  public let textureHeight: Int
  public let meshWidth: Int
  public let meshHeight: Int
  /// Flattened (x,y) pairs, mesh row-major -- the same layout Android's
  /// `Canvas.drawBitmapMesh` consumes. `nil` when the gate refused.
  public let meshVertices: [Float]?
  /// Non-nil only when the pipeline refused: the snapshot then carries no geometry.
  public let failure: String?

  public var boundsWidth: Float { boundsMax.x - boundsMin.x }
  public var boundsHeight: Float { boundsMax.y - boundsMin.y }

  /// The invariant every snapshot must satisfy before it is allowed to reach
  /// a renderer. A bad BodyFrame must fail closed, never produce a geometry
  /// explosion, a NaN, or a negative dimension.
  public func validate() -> [String] {
    if failure != nil { return [] } // a refusal carries no geometry to validate
    var problems: [String] = []
    for (id, p) in controlPoints where !p.isFinite {
      problems.append("non_finite_control_point:\(id)")
    }
    if !boundsMin.isFinite || !boundsMax.isFinite { problems.append("non_finite_bounds") }
    if boundsWidth < 0 || boundsHeight < 0 { problems.append("negative_bounds") }
    if !scale.isFinite || scale <= 0 { problems.append("invalid_scale") }
    if !rotationRadians.isFinite { problems.append("non_finite_rotation") }
    if let meshVertices = meshVertices {
      for (i, v) in meshVertices.enumerated() where !v.isFinite {
        problems.append("non_finite_mesh_vertex:\(i)")
      }
    }
    // A garment whose bounds exceed this multiple of the canvas is an
    // explosion, not a large garment: the rigid gate's own scale band
    // (0.55..1.8) cannot produce it.
    let explosionLimit: Float = 8
    if boundsWidth > canvasWidth * explosionLimit || boundsHeight > canvasHeight * explosionLimit {
      problems.append("geometry_explosion")
    }
    return problems
  }
}
