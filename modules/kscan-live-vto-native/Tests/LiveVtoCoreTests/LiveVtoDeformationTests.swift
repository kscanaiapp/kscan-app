import XCTest
@testable import LiveVtoCore

private let canvasW: Float = 720
private let canvasH: Float = 960

/// Properties of the affine-MLS deformation that hold independently of the
/// reference oracle. Field-for-field port of Android's `DeformationTest.kt`.
/// Cross-runtime agreement is measured separately by
/// `LiveVtoGeometryConformanceTests`; these are the mathematical invariants
/// that would still have to hold if the oracle vanished.
final class LiveVtoDeformationTests: XCTestCase {

  private func pair(_ sx: Float, _ sy: Float, _ tx: Float, _ ty: Float) -> LiveVtoDeformation.ControlPointPair {
    LiveVtoDeformation.ControlPointPair(source: Vec2(sx, sy), target: Vec2(tx, ty))
  }

  /// Exact interpolation at a control point -- the w_i -> infinity limit.
  /// Without this, every control point would be approximated rather than
  /// hit, and the control-point conformance table would be measuring
  /// something the mesh does not actually pass through.
  func testDeformationIsExactAtEveryControlPoint() {
    let pairs = [pair(10, 10, 100, 200), pair(200, 20, 400, 220), pair(15, 300, 120, 700), pair(210, 310, 420, 710)]
    for cp in pairs {
      let result = LiveVtoDeformation.deformVertex(cp.source, pairs)
      XCTAssertEqual(result.x, cp.target.x, accuracy: 1e-4, "x at control point \(cp.source)")
      XCTAssertEqual(result.y, cp.target.y, accuracy: 1e-4, "y at control point \(cp.source)")
    }
  }

  /// If the correspondences ARE an affine map, affine MLS must reproduce
  /// that map exactly everywhere -- not just at the control points. This is
  /// the strongest available check that the normal equations and the 2x2
  /// inverse are right, and it fails loudly for a transposed matrix or a
  /// swapped index, which a control-point-only test would not catch.
  func testAnAffineCorrespondenceIsReproducedExactlyEverywhere() {
    func affine(_ v: Vec2) -> Vec2 { Vec2(1.3 * v.x - 0.4 * v.y + 25, 0.2 * v.x + 1.1 * v.y - 12) }
    let sources = [Vec2(0, 0), Vec2(271, 0), Vec2(0, 302), Vec2(271, 302), Vec2(135, 90), Vec2(60, 240), Vec2(210, 200)]
    let pairs = sources.map { LiveVtoDeformation.ControlPointPair(source: $0, target: affine($0)) }

    for x in stride(from: 0, through: 271, by: 19) {
      for y in stride(from: 0, through: 302, by: 23) {
        let v = Vec2(Float(x), Float(y))
        let expected = affine(v)
        let actual = LiveVtoDeformation.deformVertex(v, pairs)
        XCTAssertEqual(actual.x, expected.x, accuracy: 0.02, "x at \(v)")
        XCTAssertEqual(actual.y, expected.y, accuracy: 0.02, "y at \(v)")
      }
    }
  }

  /// A pure translation is the degenerate affine case and must be exact.
  func testAPureTranslationIsReproducedExactly() {
    let pairs = [pair(0, 0, 50, 70), pair(100, 0, 150, 70), pair(0, 100, 50, 170)]
    let result = LiveVtoDeformation.deformVertex(Vec2(40, 60), pairs)
    XCTAssertEqual(result.x, 90, accuracy: 0.01)
    XCTAssertEqual(result.y, 130, accuracy: 0.01)
  }

  /// Collinear sources are singular; the reference falls back to identity rather than exploding.
  func testADegenerateControlPointConfigurationFallsBackRatherThanExploding() {
    let collinear = [pair(0, 0, 10, 10), pair(50, 0, 60, 10), pair(100, 0, 110, 10)]
    let result = LiveVtoDeformation.deformVertex(Vec2(50, 80), collinear)
    XCTAssertTrue(result.isFinite, "degenerate configuration produced non-finite geometry: \(result)")
    XCTAssertTrue(abs(result.x) < 1e5 && abs(result.y) < 1e5, "degenerate configuration exploded: \(result)")
  }

  /// `meshDefinition.width`/`height` are VERTEX counts, and the render path
  /// needs (w+1)*(h+1) vertices per cell-count pair. The snapshot must
  /// publish cell counts whose implied vertex count matches the array it
  /// also publishes -- Android's N1-ENV-011 was exactly this mismatch.
  func testTheSnapshotMeshShapeMatchesTheVertexArrayItPublishes() throws {
    let golden = try GoldenFixtures.loadBodyFrames()
    guard let neutral = golden.cases.first(where: { $0.id == "neutral-frontal" }) else { return XCTFail() }
    let frame = GoldenFixtures.bodyFrame(neutral)

    for fixtureName in ["n1b-fixture", "n1c-asym-fixture"] {
      let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: fixtureName)
      let snapshot = LiveVtoGeometryPipeline.compute(manifest: manifest, frame: frame, bodyFrameId: "neutral-frontal", canvasWidth: canvasW, canvasHeight: canvasH, textureWidth: texW, textureHeight: texH)
      guard let verts = snapshot.meshVertices else { return XCTFail("\(fixtureName): no mesh produced") }
      XCTAssertEqual(verts.count, (snapshot.meshWidth + 1) * (snapshot.meshHeight + 1) * 2, "\(fixtureName): the render path requires (meshWidth+1)*(meshHeight+1) vertices")
      XCTAssertEqual(verts.count, manifest.meshDefinition.width * manifest.meshDefinition.height * 2, "\(fixtureName): the vertex grid must be the manifest's own vertex grid")
    }
  }

  /// The deformed mesh must actually track the pose. A deformation that
  /// silently degenerated to a rigid placement would still pass the
  /// control-point conformance table (the control points are placed by a
  /// different stage), so assert the surface between them moves too.
  func testTheDeformedMeshTracksThePoseNotJustTheControlPoints() throws {
    let golden = try GoldenFixtures.loadBodyFrames()
    let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: "n1b-fixture")
    func mesh(_ id: String) throws -> [Float] {
      guard let c = golden.cases.first(where: { $0.id == id }) else { throw LiveVtoGarmentValidationError("missing golden case \(id)") }
      let snapshot = LiveVtoGeometryPipeline.compute(manifest: manifest, frame: GoldenFixtures.bodyFrame(c), bodyFrameId: id, canvasWidth: canvasW, canvasHeight: canvasH, textureWidth: texW, textureHeight: texH)
      guard let verts = snapshot.meshVertices else { throw LiveVtoGarmentValidationError("\(id): no mesh") }
      return verts
    }

    let neutral = try mesh("neutral-frontal")
    let leftUp = try mesh("left-shoulder-raised")
    let rightUp = try mesh("right-shoulder-raised")

    var movedVertices = 0
    for i in stride(from: 0, to: neutral.count, by: 2) {
      if Foundation.hypot(Double(leftUp[i] - neutral[i]), Double(leftUp[i + 1] - neutral[i + 1])) > 1.0 { movedVertices += 1 }
    }
    XCTAssertGreaterThan(movedVertices, neutral.count / 4, "raising a shoulder moved only \(movedVertices) mesh vertices")

    // The two raised-shoulder cases must be genuine mirrors, not the same mesh.
    var differing = 0
    for i in leftUp.indices where abs(leftUp[i] - rightUp[i]) > 1 { differing += 1 }
    XCTAssertGreaterThan(differing, leftUp.count / 4, "the left- and right-raised meshes are indistinguishable")
  }

  /// Deformation stays finite across every valid golden, both fixtures.
  func testEveryGoldenProducesAFiniteMesh() throws {
    let golden = try GoldenFixtures.loadBodyFrames()
    for fixtureName in ["n1b-fixture", "n1c-asym-fixture"] {
      let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: fixtureName)
      for c in golden.cases {
        let snapshot = LiveVtoGeometryPipeline.compute(manifest: manifest, frame: GoldenFixtures.bodyFrame(c), bodyFrameId: c.id, canvasWidth: canvasW, canvasHeight: canvasH, textureWidth: texW, textureHeight: texH)
        guard let verts = snapshot.meshVertices else { XCTFail("\(fixtureName)/\(c.id): no mesh produced"); continue }
        for (i, value) in verts.enumerated() {
          XCTAssertTrue(value.isFinite, "\(fixtureName)/\(c.id): non-finite mesh vertex at \(i)")
        }
      }
    }
  }
}
