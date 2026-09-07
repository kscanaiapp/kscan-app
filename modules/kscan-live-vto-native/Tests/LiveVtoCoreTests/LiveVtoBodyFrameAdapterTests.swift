import XCTest
@testable import LiveVtoCore

private let canvasW: Float = 720
private let canvasH: Float = 960

/// `LiveVtoBodyFrameAdapter` tested against hand-built `RawPoseFrame`
/// fixtures shaped exactly like the real MediaPipe Pose 33-point topology.
/// Field-for-field port of Android's `BodyFrameAdapterTest.kt`.
///
/// These are NOT a substitute for real on-device inference -- hardcoded
/// landmarks do not count as `REAL_MODEL EXECUTED: YES`. What they DO prove,
/// independent of whether any simulator or device can run the real model, is
/// that the ADAPTER'S OWN mapping logic is correct: absent vs. non-finite vs.
/// low-confidence handling, and that the adapter introduces no left/right
/// swap of its own -- exactly the defect class this lane's Android history
/// warns is easy to get wrong.
final class LiveVtoBodyFrameAdapterTests: XCTestCase {

  private func blankLandmarks() -> [RawPoseLandmark] {
    (0..<PoseLandmarkIndex.count).map { _ in RawPoseLandmark(x: 0, y: 0, confidence: 0, present: false) }
  }

  private func present(_ x: Float, _ y: Float, confidence: Float = 0.9) -> RawPoseLandmark {
    RawPoseLandmark(x: x, y: y, confidence: confidence, present: true)
  }

  private func neutralFrame() -> RawPoseFrame {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.nose] = present(0.5, 0.15)
    lm[PoseLandmarkIndex.leftShoulder] = present(0.38, 0.28)
    lm[PoseLandmarkIndex.rightShoulder] = present(0.62, 0.28)
    lm[PoseLandmarkIndex.leftElbow] = present(0.32, 0.45)
    lm[PoseLandmarkIndex.rightElbow] = present(0.68, 0.45)
    lm[PoseLandmarkIndex.leftWrist] = present(0.30, 0.60)
    lm[PoseLandmarkIndex.rightWrist] = present(0.70, 0.60)
    lm[PoseLandmarkIndex.leftHip] = present(0.40, 0.60)
    lm[PoseLandmarkIndex.rightHip] = present(0.60, 0.60)
    return RawPoseFrame(timestampMs: 1000, landmarks: lm, poseConfidence: 0.95)
  }

  // MARK: - Basic mapping

  func testAWellFormedFrameMapsEveryGovernedFieldItCanAndNoneItCannot() {
    guard case .mapped(let frame) = LiveVtoBodyFrameAdapter.adapt(neutralFrame()) else {
      return XCTFail("expected .mapped")
    }
    XCTAssertEqual(frame.timestampMs, 1000)
    XCTAssertTrue(frame.leftShoulder.isPresent)
    XCTAssertTrue(frame.rightShoulder.isPresent)
    XCTAssertTrue(frame.leftHip.isPresent)
    XCTAssertTrue(frame.rightHip.isPresent)
    XCTAssertTrue(frame.neckCenter.isPresent, "no neck landmark in BlazePose -- must be a derived proxy, not absent, when both shoulders are present")
    XCTAssertNotNil(frame.torsoWidth)
    XCTAssertGreaterThan(frame.torsoWidth ?? 0, 0)
    XCTAssertNotNil(frame.torsoHeight)
    XCTAssertGreaterThan(frame.torsoHeight ?? 0, 0)

    guard case .present(let ls, _) = frame.leftShoulder else { return XCTFail() }
    XCTAssertEqual(ls.x, 0.38, accuracy: 1e-6)
    XCTAssertEqual(ls.y, 0.28, accuracy: 1e-6)
  }

  func testTheEntireGeometryPipelineAcceptsAnAdaptedFrame() throws {
    guard case .mapped(let frame) = LiveVtoBodyFrameAdapter.adapt(neutralFrame()) else { return XCTFail() }
    let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: "n1b-fixture")
    let snapshot = LiveVtoGeometryPipeline.compute(manifest: manifest, frame: frame, bodyFrameId: "adapter-neutral", canvasWidth: canvasW, canvasHeight: canvasH, textureWidth: texW, textureHeight: texH)
    XCTAssertNil(snapshot.failure, "adapted frame was refused by geometry: \(snapshot.failure ?? "?")")
    XCTAssertTrue(snapshot.gatePassed, "adapted frame failed the rigid gate: \(snapshot.gateFindings)")
  }

  // MARK: - Left/right canary

  func testTheAdapterIntroducesNoLeftRightSwap() {
    var lm = blankLandmarks()
    // Deliberately asymmetric and far from the neutral fixture's values, so
    // this cannot pass by coincidentally matching another test's numbers.
    lm[PoseLandmarkIndex.leftShoulder] = present(0.20, 0.25)
    lm[PoseLandmarkIndex.rightShoulder] = present(0.75, 0.30)
    lm[PoseLandmarkIndex.leftHip] = present(0.25, 0.65)
    lm[PoseLandmarkIndex.rightHip] = present(0.70, 0.65)
    guard case .mapped(let f) = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 2000, landmarks: lm, poseConfidence: 0.9)) else { return XCTFail() }

    guard case .present(let ls, _) = f.leftShoulder, case .present(let rs, _) = f.rightShoulder,
          case .present(let lh, _) = f.leftHip, case .present(let rh, _) = f.rightHip else { return XCTFail() }

    XCTAssertEqual(ls.x, 0.20, accuracy: 1e-6, "provider left_shoulder must become BodyFrame.leftShoulder verbatim")
    XCTAssertEqual(rs.x, 0.75, accuracy: 1e-6, "provider right_shoulder must become BodyFrame.rightShoulder verbatim")
    XCTAssertEqual(lh.x, 0.25, accuracy: 1e-6)
    XCTAssertEqual(rh.x, 0.70, accuracy: 1e-6)
    XCTAssertLessThan(ls.x, rs.x, "left must stay left")
    XCTAssertLessThan(lh.x, rh.x, "left hip must stay left")
  }

  func testTheCanaryFrameSurvivesGeometryWithoutAMirrorFinding() throws {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.leftShoulder] = present(0.30, 0.28)
    lm[PoseLandmarkIndex.rightShoulder] = present(0.70, 0.28)
    lm[PoseLandmarkIndex.leftHip] = present(0.35, 0.60)
    lm[PoseLandmarkIndex.rightHip] = present(0.65, 0.60)
    lm[PoseLandmarkIndex.leftElbow] = present(0.20, 0.45)
    lm[PoseLandmarkIndex.rightElbow] = present(0.80, 0.45)
    guard case .mapped(let frame) = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 3000, landmarks: lm, poseConfidence: 0.9)) else { return XCTFail() }

    let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: "n1c-asym-fixture")
    let snapshot = LiveVtoGeometryPipeline.compute(manifest: manifest, frame: frame, bodyFrameId: "adapter-canary", canvasWidth: canvasW, canvasHeight: canvasH, textureWidth: texW, textureHeight: texH)

    XCTAssertNil(snapshot.failure)
    XCTAssertFalse(snapshot.gateFindings.contains("left_right_inversion"), "left/right inversion reported for a straight-mapped asymmetric frame")
    guard let gLeft = snapshot.controlPoints["leftShoulder"], let gRight = snapshot.controlPoints["rightShoulder"] else { return XCTFail() }
    XCTAssertLessThan(gLeft.x, gRight.x, "garment left must stay left of garment right")
  }

  // MARK: - Non-finite provider output

  func testANaNLandmarkCoordinateIsRejectedAsInvalidProviderOutputNotAsAbsent() {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.leftShoulder] = present(.nan, 0.28)
    lm[PoseLandmarkIndex.rightShoulder] = present(0.62, 0.28)
    lm[PoseLandmarkIndex.leftHip] = present(0.40, 0.60)
    lm[PoseLandmarkIndex.rightHip] = present(0.60, 0.60)
    guard case .invalidProviderOutput = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 4000, landmarks: lm, poseConfidence: 0.9)) else {
      return XCTFail("expected .invalidProviderOutput")
    }
  }

  func testAnInfiniteConfidenceIsRejectedAsInvalidProviderOutput() {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.leftShoulder] = present(0.38, 0.28, confidence: .infinity)
    lm[PoseLandmarkIndex.rightShoulder] = present(0.62, 0.28)
    lm[PoseLandmarkIndex.leftHip] = present(0.40, 0.60)
    lm[PoseLandmarkIndex.rightHip] = present(0.60, 0.60)
    guard case .invalidProviderOutput = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 5000, landmarks: lm, poseConfidence: 0.9)) else {
      return XCTFail("expected .invalidProviderOutput")
    }
  }

  func testANonFiniteOverallPoseConfidenceIsRejected() {
    guard case .invalidProviderOutput = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 6000, landmarks: blankLandmarks(), poseConfidence: .nan)) else {
      return XCTFail("expected .invalidProviderOutput")
    }
  }

  // MARK: - Absent / missing landmarks

  func testAnAbsentLandmarkMapsToAbsentNeverToAGuessedZero() {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.leftShoulder] = present(0.38, 0.28)
    lm[PoseLandmarkIndex.rightShoulder] = present(0.62, 0.28)
    lm[PoseLandmarkIndex.leftHip] = present(0.40, 0.60)
    lm[PoseLandmarkIndex.rightHip] = present(0.60, 0.60)
    // leftElbow/rightWrist left absent (present = false, the blank default).
    guard case .mapped(let frame) = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 7000, landmarks: lm, poseConfidence: 0.9)) else { return XCTFail() }
    XCTAssertEqual(frame.leftElbow, .absent)
    XCTAssertEqual(frame.rightWrist, .absent)
  }

  func testMissingBothShouldersButPresentHipsStillProducesNoUsablePoseWhenHipsAlsoBelowThreshold() {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.leftHip] = present(0.40, 0.60, confidence: 0.1)
    lm[PoseLandmarkIndex.rightHip] = present(0.60, 0.60, confidence: 0.1)
    guard case .noUsablePose = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 8000, landmarks: lm, poseConfidence: 0.9)) else {
      return XCTFail("expected .noUsablePose")
    }
  }

  func testOneCriticalLandmarkPresentIsEnoughToAttemptAMapping() {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.leftShoulder] = present(0.38, 0.28)
    guard case .mapped = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 9000, landmarks: lm, poseConfidence: 0.9)) else {
      return XCTFail("expected .mapped -- the adapter must not refuse merely because the frame is partial")
    }
  }

  // MARK: - Low confidence

  func testACriticalLandmarkBelowTheConfidenceFloorIsDemotedToAbsentNotPresent() {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.leftShoulder] = present(0.38, 0.28, confidence: 0.05) // well under the floor
    lm[PoseLandmarkIndex.rightShoulder] = present(0.62, 0.28, confidence: 0.95)
    lm[PoseLandmarkIndex.leftHip] = present(0.40, 0.60, confidence: 0.95)
    lm[PoseLandmarkIndex.rightHip] = present(0.60, 0.60, confidence: 0.95)
    guard case .mapped(let frame) = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 10000, landmarks: lm, poseConfidence: 0.9)) else { return XCTFail() }
    XCTAssertEqual(frame.leftShoulder, .absent, "a low-confidence critical landmark must not be treated as strong tracking")
  }

  func testTrackingConfidencePropagatesAsTheMinimumOverCriticalLandmarks() {
    var lm = blankLandmarks()
    lm[PoseLandmarkIndex.leftShoulder] = present(0.38, 0.28, confidence: 0.99)
    lm[PoseLandmarkIndex.rightShoulder] = present(0.62, 0.28, confidence: 0.60)
    lm[PoseLandmarkIndex.leftHip] = present(0.40, 0.60, confidence: 0.99)
    lm[PoseLandmarkIndex.rightHip] = present(0.60, 0.60, confidence: 0.99)
    guard case .mapped(let frame) = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 11000, landmarks: lm, poseConfidence: 0.9)) else { return XCTFail() }
    XCTAssertEqual(frame.trackingConfidence, 0.60, accuracy: 1e-6)
  }

  func testAFrameWithNoCriticalLandmarksAtAllIsNoUsablePose() {
    guard case .noUsablePose = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(timestampMs: 12000, landmarks: blankLandmarks(), poseConfidence: 0.9)) else {
      return XCTFail("expected .noUsablePose")
    }
  }
}
