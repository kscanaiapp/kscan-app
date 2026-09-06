import Foundation

/// The single geometry entry point: (garment manifest, BodyFrame) -> GeometrySnapshot.
///
/// Every consumer goes through here -- the diagnostic render view, the
/// SwiftPM conformance tests, and the replay/perception pipelines' geometry
/// compute. One code path means a snapshot captured in a test is, by
/// construction, the geometry the renderer would draw, and a later renderer-
/// backend change cannot silently diverge from what the goldens measured.
/// Field-for-field port of Android's `LiveVtoGeometryPipeline.kt`.
///
/// Pure: no UIKit types, no I/O, no clock, no thread affinity. Safe to run on
/// a background queue and safe to run thousands of times in a SwiftPM test.
///
/// FAIL-CLOSED CONTRACT. Every refusal path returns a snapshot whose
/// `failure` is set and whose geometry is empty. It never traps, never
/// returns half-computed geometry, and never invents a landmark it was not
/// given.
public enum LiveVtoGeometryPipeline {

  /// Reasons the pipeline refuses. Stable strings -- goldens assert on them.
  /// Identical string values to Android's `LiveVtoGeometryPipeline.Refusal`
  /// so a golden fixture's expected refusal reason means the same thing on
  /// both platforms.
  public enum Refusal {
    public static let missingShoulders = "missing_shoulders"
    public static let missingHips = "missing_hips"
    public static let degenerateShoulderSpan = "degenerate_shoulder_span"
    public static let degenerateBodyAxis = "degenerate_body_axis"
    public static let nonFiniteLandmark = "non_finite_landmark"
    public static let missingGarmentControlPoints = "missing_garment_control_points"
    public static let degenerateGarmentSpan = "degenerate_garment_span"
    public static let nonFiniteGeometry = "non_finite_geometry"
  }

  public static func compute(
    manifest: KsgarmentManifest, frame: BodyFrame, bodyFrameId: String,
    canvasWidth: Float, canvasHeight: Float, textureWidth: Int, textureHeight: Int
  ) -> GeometrySnapshot {
    func refuse(_ reason: String) -> GeometrySnapshot {
      GeometrySnapshot(
        fixtureId: manifest.productId, bodyFrameId: bodyFrameId, activeAssetId: manifest.productId,
        assetVersion: manifest.assetVersion, controlPoints: [:], boundsMin: Vec2(0, 0), boundsMax: Vec2(0, 0),
        scale: 0, rotationRadians: 0, gatePassed: false, gateFindings: [],
        canvasWidth: canvasWidth, canvasHeight: canvasHeight, textureWidth: textureWidth, textureHeight: textureHeight,
        meshWidth: manifest.meshDefinition.width - 1, meshHeight: manifest.meshDefinition.height - 1,
        meshVertices: nil, failure: reason)
    }

    let anchors: BodyAnchors
    switch extractBodyAnchors(frame, canvasWidth: canvasWidth, canvasHeight: canvasHeight) {
    case .failure(let reason): return refuse(reason)
    case .success(let a): anchors = a
    }

    let targets: ControlPointTargets
    do {
      targets = try computeControlPointTargets(anchors, manifest: manifest, textureWidth: textureWidth, textureHeight: textureHeight)
    } catch let e as LiveVtoGeometryRefusal {
      return refuse(e.reason)
    } catch {
      return refuse(Refusal.nonFiniteGeometry)
    }

    guard let placement = fitRigidPlacement(manifest: manifest, targets: targets, textureWidth: textureWidth, textureHeight: textureHeight) else {
      return refuse(Refusal.missingGarmentControlPoints)
    }
    let gate = evaluateRigidGate(anchors: anchors, manifest: manifest, placement: placement, textureWidth: textureWidth, textureHeight: textureHeight)

    // Deformation only runs behind a passing rigid gate: "deformation cannot
    // repair incorrect semantic anchoring" (P3-A attachment.ts).
    let meshVertices: [Float]? = gate.passed
      ? LiveVtoDeformation.buildDeformedMesh(manifest: manifest, targets: targets.targets, textureWidth: textureWidth, textureHeight: textureHeight)
      : nil

    if targets.targets.isEmpty { return refuse(Refusal.missingGarmentControlPoints) }
    var minX = Float.greatestFiniteMagnitude, minY = Float.greatestFiniteMagnitude
    var maxX = -Float.greatestFiniteMagnitude, maxY = -Float.greatestFiniteMagnitude
    for p in targets.targets.values {
      if !p.isFinite { return refuse(Refusal.nonFiniteGeometry) }
      minX = min(minX, p.x); minY = min(minY, p.y)
      maxX = max(maxX, p.x); maxY = max(maxY, p.y)
    }
    if !placement.scale.isFinite || !placement.rotationRadians.isFinite { return refuse(Refusal.nonFiniteGeometry) }
    if let meshVertices = meshVertices, meshVertices.contains(where: { !$0.isFinite }) { return refuse(Refusal.nonFiniteGeometry) }

    return GeometrySnapshot(
      fixtureId: manifest.productId, bodyFrameId: bodyFrameId, activeAssetId: manifest.productId,
      assetVersion: manifest.assetVersion,
      controlPoints: Dictionary(uniqueKeysWithValues: targets.targets.map { ($0.key.rawValue, $0.value) }),
      boundsMin: Vec2(minX, minY), boundsMax: Vec2(maxX, maxY),
      scale: placement.scale, rotationRadians: placement.rotationRadians,
      gatePassed: gate.passed, gateFindings: gate.findings,
      canvasWidth: canvasWidth, canvasHeight: canvasHeight, textureWidth: textureWidth, textureHeight: textureHeight,
      meshWidth: manifest.meshDefinition.width - 1, meshHeight: manifest.meshDefinition.height - 1,
      meshVertices: meshVertices, failure: nil)
  }
}
