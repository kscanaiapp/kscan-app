import XCTest
@testable import LiveVtoCore

private struct ControlledInput: PerceptionInputFrame {
  let width = 720
  let height = 960
}
private final class ControlledPoseProvider: PerceptionProvider {
  var present = true
  var disposed = false
  func initialize() -> Bool { !disposed }
  func reset() {}
  func dispose() { disposed = true }
  func getCapability() -> PerceptionCapability {
    .init(moduleAvailable: true, perceptionReady: !disposed, providerName: "controlled-test", modelName: "none", reason: nil)
  }
  func processFrame(_ frame: PerceptionInputFrame) -> PerceptionResult {
    if !present { return .noPose(reason: "controlled loss") }
    var landmarks = (0..<33).map { _ in RawPoseLandmark(x: 0, y: 0, confidence: 0, present: false) }
    let points: [(Int, Float, Float)] = [(11, 0.38, 0.28), (12, 0.62, 0.28), (23, 0.4, 0.6), (24, 0.6, 0.6)]
    for (index, x, y) in points {
      landmarks[index] = .init(x: x, y: y, confidence: 0.9, present: true)
    }
    return .success(frame: .init(timestampMs: 1000, landmarks: landmarks, poseConfidence: 0.9))
  }
}

final class LiveVtoTrackingRecoveryTests: XCTestCase {
  func testLostPoseClearsTheOldGarmentAndRecoveryProducesGeometry() throws {
    let provider = ControlledPoseProvider()
    var losses = 0
    let session = LiveVtoPerceptionSession(provider: provider, canvasWidth: 720, canvasHeight: 960, onPoseUnavailable: { losses += 1 })
    let (manifest, width, height) = try GoldenFixtures.loadManifest(fixture: "ascolour-5001-black-v1")
    XCTAssertTrue(session.load(manifest, textureWidth: width, textureHeight: height))
    XCTAssertTrue(session.start())
    for visible in [true, false, true] {
      provider.present = visible
      XCTAssertTrue(session.submitFrame(ControlledInput()))
      XCTAssertTrue(session.runOneInferenceStep())
      XCTAssertEqual(session.geometrySlot.peek()?.meshVertices != nil, visible)
    }
    XCTAssertEqual(losses, 1)
    XCTAssertTrue(session.stop())
    XCTAssertNil(session.geometrySlot.peek())
    XCTAssertTrue(session.dispose())
    XCTAssertTrue(provider.disposed)
  }
}
