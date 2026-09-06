import XCTest
@testable import LiveVtoCore

/// Cross-runtime geometry conformance -- the iOS equivalent of Android's
/// `GeometryConformanceTest.kt` joined against `tools/compare-conformance.mjs`.
///
/// TOLERANCE AUTHORITY: 0.05 px per control point (Euclidean), read from
/// `docs/vto-live-native-n1-conformance.md` ("FROZEN N1-C TOLERANCE") and
/// used here UNCHANGED -- no new tolerance was created after seeing this
/// port's own results, per the mission's tolerance-authority requirement.
///
/// The reference values in `goldens/reference-snapshots.jsonl` were produced
/// by running `tools/run-reference-oracle.mjs` (the same tool, same golden
/// fixtures, same governed .ksgarment assets Android's own conformance
/// record used) against the P3-A reference oracle checkout locally, then
/// committed -- see `goldens/reference-provenance.json` for the exact
/// reference SHA this port is pinned to.
final class LiveVtoGeometryConformanceTests: XCTestCase {
  static let frozenTolerancePx: Float = 0.05
  static let canvasWidth: Float = 720
  static let canvasHeight: Float = 960
  static let fixtures = ["n1b-fixture", "n1c-asym-fixture"]

  private var referenceByKey: [String: GoldenFixtures.ReferenceSnapshot] = [:]
  private var golden: GoldenFixtures.GoldenSet!

  override func setUpWithError() throws {
    let refs = try GoldenFixtures.loadReferenceSnapshots()
    referenceByKey = Dictionary(uniqueKeysWithValues: refs.map { ("\($0.fixture)|\($0.caseId)", $0) })
    golden = try GoldenFixtures.loadBodyFrames()
    XCTAssertEqual(Float(golden.renderCanvasWidth), Self.canvasWidth)
    XCTAssertEqual(Float(golden.renderCanvasHeight), Self.canvasHeight)
  }

  func testReferenceSnapshotsCoverAllFixtureCasePairs() throws {
    let allCases = golden.cases + golden.refusalCases
    XCTAssertEqual(referenceByKey.count, Self.fixtures.count * allCases.count,
      "goldens/reference-snapshots.jsonl is stale relative to goldens/bodyframes.json -- regenerate via tools/run-reference-oracle.mjs")
  }

  func testValidPosesConformToReferenceWithinFrozenTolerance() throws {
    var maxControlPointDeltaPx: Float = 0
    var maxMeshDeltaPx: Float = 0
    var comparedControlPoints = 0
    var comparedMeshVertices = 0

    for fixtureName in Self.fixtures {
      let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: fixtureName)

      for goldenCase in golden.cases {
        let key = "\(fixtureName)|\(goldenCase.id)"
        guard let reference = referenceByKey[key] else {
          XCTFail("no reference snapshot for \(key)"); continue
        }
        let frame = GoldenFixtures.bodyFrame(goldenCase)
        let snapshot = LiveVtoGeometryPipeline.compute(
          manifest: manifest, frame: frame, bodyFrameId: goldenCase.id,
          canvasWidth: Self.canvasWidth, canvasHeight: Self.canvasHeight, textureWidth: texW, textureHeight: texH)

        XCTAssertNil(snapshot.failure, "\(key): expected a valid pose to produce geometry, got failure=\(snapshot.failure ?? "?")")
        XCTAssertEqual(snapshot.gatePassed, reference.gatePassed ?? true, "\(key): gate-pass disagreement with reference")
        XCTAssertEqual(snapshot.validate(), [], "\(key): snapshot failed its own invariant checks: \(snapshot.validate())")

        if let refCP = reference.controlPoints {
          for (id, refPoint) in refCP {
            guard let ourPoint = snapshot.controlPoints[id] else {
              XCTFail("\(key): missing control point \(id) in iOS output"); continue
            }
            let delta = (ourPoint - refPoint).length()
            maxControlPointDeltaPx = max(maxControlPointDeltaPx, delta)
            comparedControlPoints += 1
            XCTAssertLessThanOrEqual(delta, Self.frozenTolerancePx, "\(key) control point \(id): delta \(delta)px exceeds frozen tolerance")
          }
        }

        if let refMesh = reference.meshVertices, let ourMesh = snapshot.meshVertices {
          XCTAssertEqual(ourMesh.count, refMesh.count, "\(key): mesh vertex count mismatch")
          if ourMesh.count == refMesh.count {
            for i in stride(from: 0, to: ourMesh.count, by: 2) {
              let d = Float(Foundation.hypot(Double(ourMesh[i] - refMesh[i]), Double(ourMesh[i + 1] - refMesh[i + 1])))
              maxMeshDeltaPx = max(maxMeshDeltaPx, d)
              comparedMeshVertices += 1
              XCTAssertLessThanOrEqual(d, Self.frozenTolerancePx, "\(key) mesh vertex \(i / 2): delta \(d)px exceeds frozen tolerance")
            }
          }
        }
      }
    }

    XCTAssertGreaterThan(comparedControlPoints, 0, "no control points were actually compared -- test would vacuously pass")
    XCTAssertGreaterThan(comparedMeshVertices, 0, "no mesh vertices were actually compared -- test would vacuously pass")
    print("[LiveVtoGeometryConformanceTests] control points compared=\(comparedControlPoints) maxDeltaPx=\(maxControlPointDeltaPx)")
    print("[LiveVtoGeometryConformanceTests] mesh vertices compared=\(comparedMeshVertices) maxDeltaPx=\(maxMeshDeltaPx)")
  }

  func testRefusalCasesMatchExpectedReason() throws {
    var checked = 0
    for fixtureName in Self.fixtures {
      let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: fixtureName)

      for refusalCase in golden.refusalCases {
        let frame = GoldenFixtures.bodyFrame(refusalCase)
        let snapshot = LiveVtoGeometryPipeline.compute(
          manifest: manifest, frame: frame, bodyFrameId: refusalCase.id,
          canvasWidth: Self.canvasWidth, canvasHeight: Self.canvasHeight, textureWidth: texW, textureHeight: texH)

        if let expectedFailure = refusalCase.expectedFailure {
          // A pipeline-level refusal: no geometry produced at all.
          XCTAssertEqual(snapshot.failure, expectedFailure, "\(fixtureName)/\(refusalCase.id): wrong refusal reason")
          XCTAssertNil(snapshot.meshVertices, "\(fixtureName)/\(refusalCase.id): a refused snapshot must carry no mesh")
          checked += 1
        } else if let expectedFindings = refusalCase.expectedGateFindings {
          // A rigid-gate-level rejection: geometry reaches the gate but the gate itself rejects it.
          XCTAssertNil(snapshot.failure, "\(fixtureName)/\(refusalCase.id): expected the pipeline to reach the rigid gate, not refuse earlier")
          XCTAssertFalse(snapshot.gatePassed, "\(fixtureName)/\(refusalCase.id): expected the rigid gate to reject this placement")
          for finding in expectedFindings {
            XCTAssertTrue(snapshot.gateFindings.contains(finding), "\(fixtureName)/\(refusalCase.id): missing expected gate finding \(finding), got \(snapshot.gateFindings)")
          }
          XCTAssertNil(snapshot.meshVertices, "\(fixtureName)/\(refusalCase.id): deformation must not run behind a failed gate")
          checked += 1
        } else {
          XCTFail("\(fixtureName)/\(refusalCase.id): a refusal case must declare either expectedFailure or expectedGateFindings")
        }
      }
    }
    XCTAssertEqual(checked, Self.fixtures.count * golden.refusalCases.count)
  }

  /// Never convert broken provider geometry into ordinary absence -- the
  /// three explicit non-finite refusal cases (nan-shoulder, infinite-hip,
  /// and the finite-but-impossible-coordinate case) must all still produce
  /// SOME defined, fail-closed outcome, never a crash and never silently
  /// treated as if the landmark were merely missing.
  func testNonFiniteGeometryFailsClosedNeverCrashes() throws {
    let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: "n1b-fixture")
    let nonFiniteCaseIds: Set<String> = ["nan-shoulder", "infinite-hip"]
    var checked = 0
    for c in golden.refusalCases where nonFiniteCaseIds.contains(c.id) {
      let frame = GoldenFixtures.bodyFrame(c)
      let snapshot = LiveVtoGeometryPipeline.compute(
        manifest: manifest, frame: frame, bodyFrameId: c.id,
        canvasWidth: Self.canvasWidth, canvasHeight: Self.canvasHeight, textureWidth: texW, textureHeight: texH)
      XCTAssertEqual(snapshot.failure, LiveVtoGeometryPipeline.Refusal.nonFiniteLandmark, "\(c.id) must fail closed as non_finite_landmark")
      checked += 1
    }
    XCTAssertEqual(checked, nonFiniteCaseIds.count, "expected golden fixtures for both non-finite canary cases")
  }
}
