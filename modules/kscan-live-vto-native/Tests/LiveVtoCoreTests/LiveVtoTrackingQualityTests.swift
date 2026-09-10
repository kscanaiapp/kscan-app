import XCTest
@testable import LiveVtoCore

/// Executes the SHARED cross-platform tracking-quality fixture
/// (`goldens/tracking-quality-scenarios.json`) against the real
/// `LiveVtoTrackingQualityMachine`.
///
/// THE SAME FILE ANDROID RUNS. `TrackingQualityConformanceTest.kt` executes
/// this exact fixture, step for step, with the same tolerance. Mission
/// section 13 requires the two platforms to resolve the SAME governed input
/// to the SAME logical state; two suites of hand-written cases that merely
/// look alike cannot prove that, because the first typo reads as a genuine
/// divergence and a genuine divergence reads as a typo. One committed file,
/// two runners.
///
/// FLOAT WIDENING IS REAL. `Double(Float(0.9))` is 0.8999999761581421, so
/// every confidence comparison uses the fixture's own declared tolerance
/// rather than exact equality.
final class LiveVtoTrackingQualityTests: XCTestCase {

  private func loadFixture() throws -> [String: Any] {
    let url = GoldenFixtures.moduleRoot.appendingPathComponent("goldens/tracking-quality-scenarios.json")
    let data = try Data(contentsOf: url)
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      XCTFail("tracking-quality-scenarios.json is not a JSON object")
      return [:]
    }
    return root
  }

  /// JSON cannot carry NaN, so the fixture spells it as the string "NaN".
  private func confidence(_ raw: Any?) -> Float {
    if let number = raw as? NSNumber { return number.floatValue }
    if let text = raw as? String, text == "NaN" { return Float.nan }
    XCTFail("unsupported confidence literal: \(String(describing: raw))")
    return 0
  }

  func testMachineMatchesEveryStepOfTheSharedCrossPlatformFixture() throws {
    let doc = try loadFixture()
    let tolerance = (doc["confidenceTolerance"] as? NSNumber)?.doubleValue ?? 1e-6
    let scenarios = doc["scenarios"] as? [[String: Any]] ?? []
    XCTAssertFalse(scenarios.isEmpty, "the shared fixture must actually contain scenarios")

    var stepsExecuted = 0
    for scenario in scenarios {
      let name = scenario["name"] as? String ?? "<unnamed>"
      let machine = LiveVtoTrackingQualityMachine()

      for (index, step) in (scenario["steps"] as? [[String: Any]] ?? []).enumerated() {
        let where_ = "\(name) step \(index + 1)"
        var event: LiveVtoTrackingEvent?

        switch step["kind"] as? String {
        case "observe":
          let outcome: LiveVtoPerceptionOutcome
          switch step["outcome"] as? String {
          case "POSE_RESOLVED": outcome = .poseResolved
          case "POSE_REFUSED": outcome = .poseRefused
          default:
            XCTFail("unknown outcome at \(where_)")
            return
          }
          event = machine.observe(
            LiveVtoTrackingObservation(
              monotonicMs: Int64((step["monotonicMs"] as? NSNumber)?.int64Value ?? 0),
              outcome: outcome,
              trackingConfidence: confidence(step["trackingConfidence"]),
              geometryGatePassed: (step["geometryGatePassed"] as? Bool) == true,
              geometryFailure: step["geometryFailure"] as? String,
              personFrameAvailable: (step["personFrameAvailable"] as? Bool) == true
            )
          )
        case "tick":
          event = machine.tick(
            monotonicMs: Int64((step["monotonicMs"] as? NSNumber)?.int64Value ?? 0),
            personFrameAvailable: (step["personFrameAvailable"] as? Bool) == true
          )
        case "reset":
          machine.reset()
          event = nil
        default:
          XCTFail("unknown step kind at \(where_)")
          return
        }

        let expect = step["expect"] as? [String: Any] ?? [:]
        if let expectedEvent = expect["event"] as? [String: Any] {
          guard let actual = event else {
            XCTFail("\(where_) must emit \(expectedEvent["name"] ?? "?"), got nothing")
            return
          }
          XCTAssertEqual(actual.name, expectedEvent["name"] as? String, "\(where_) event name")
          let expectedPayload = expectedEvent["payload"] as? [String: Any] ?? [:]
          XCTAssertEqual(
            actual.payload.keys.sorted(), expectedPayload.keys.sorted(), "\(where_) payload keys"
          )
          for (key, expectedValue) in expectedPayload {
            if key == "confidence" {
              let expectedNumber = (expectedValue as? NSNumber)?.doubleValue ?? .nan
              let actualNumber = actual.payload[key] as? Double ?? .nan
              XCTAssertLessThanOrEqual(
                abs(expectedNumber - actualNumber), tolerance,
                "\(where_) payload.confidence expected \(expectedNumber) got \(actualNumber)"
              )
            } else {
              XCTAssertEqual(
                actual.payload[key] as? Bool, expectedValue as? Bool, "\(where_) payload.\(key)"
              )
            }
          }
        } else {
          XCTAssertNil(event, "\(where_) must emit nothing, got \(String(describing: event?.name))")
        }

        let snapshot = machine.snapshot()
        XCTAssertEqual(snapshot.phase.rawValue, expect["phase"] as? String, "\(where_) phase")
        XCTAssertEqual(snapshot.guidance.wireToken, expect["guidance"] as? String, "\(where_) guidance")
        XCTAssertEqual(
          snapshot.captureReady, (expect["captureReady"] as? Bool) == true, "\(where_) captureReady"
        )
        let expectedConfidence = (expect["confidence"] as? NSNumber)?.doubleValue ?? .nan
        XCTAssertLessThanOrEqual(
          abs(expectedConfidence - Double(snapshot.confidence)), tolerance,
          "\(where_) confidence expected \(expectedConfidence) got \(snapshot.confidence)"
        )
        stepsExecuted += 1
      }
    }

    // A conformance runner that silently executed zero steps is a false
    // green, not a pass.
    XCTAssertGreaterThanOrEqual(stepsExecuted, 40, "the fixture runner executed no steps at all")
  }

  /// The thresholds are contract, not implementation detail: Android declares
  /// the same values and the fixture was derived from them. A change to any
  /// of them has to change the fixture too, and this makes that mechanical.
  func testDeclaredThresholdsMatchTheSharedFixtureParameters() throws {
    let parameters = try loadFixture()["parameters"] as? [String: Any] ?? [:]
    func number(_ key: String) -> Double { (parameters[key] as? NSNumber)?.doubleValue ?? .nan }

    XCTAssertEqual(number("strongConfidence"), Double(LiveVtoTrackingQualityMachine.strongConfidenceDefault), accuracy: 1e-6)
    XCTAssertEqual(number("weakFloorConfidence"), Double(LiveVtoTrackingQualityMachine.weakFloorConfidenceDefault), accuracy: 1e-6)
    XCTAssertEqual(Int(number("acquireStreak")), LiveVtoTrackingQualityMachine.acquireStreakDefault)
    XCTAssertEqual(Int(number("demoteStreak")), LiveVtoTrackingQualityMachine.demoteStreakDefault)
    XCTAssertEqual(Int64(number("weakAfterMs")), LiveVtoTrackingQualityMachine.weakAfterMsDefault)
    XCTAssertEqual(Int64(number("lostAfterMs")), LiveVtoTrackingQualityMachine.lostAfterMsDefault)
    XCTAssertEqual(Int64(number("reEmitIntervalMs")), LiveVtoTrackingQualityMachine.reEmitIntervalMsDefault)
  }

  /// Every guidance token this machine can produce must exist in
  /// `types/vtoLive.ts`'s `LiveVtoGuidance` union. A token the app cannot
  /// parse reaches the reducer, fails its string check, and silently degrades
  /// to 'none' -- guidance that vanishes rather than guidance that is wrong,
  /// which is much harder to notice.
  func testEveryGuidanceTokenExistsInTheApplicationContract() throws {
    let contractURL = GoldenFixtures.moduleRoot
      .deletingLastPathComponent() // modules/
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("types/vtoLive.ts")
    let contract = try String(contentsOf: contractURL, encoding: .utf8)
    guard let unionStart = contract.range(of: "export type LiveVtoGuidance =") else {
      XCTFail("types/vtoLive.ts no longer declares LiveVtoGuidance")
      return
    }
    let tail = contract[unionStart.upperBound...]
    let union = String(tail[..<(tail.firstIndex(of: ";") ?? tail.endIndex)])

    let all: [LiveVtoTrackingGuidance] = [
      .none, .stepBack, .stepCloser, .centerYourself, .improveLighting, .holdStill,
    ]
    for guidance in all {
      XCTAssertTrue(
        union.contains("'\(guidance.wireToken)'"),
        "LiveVtoGuidance in types/vtoLive.ts has no '\(guidance.wireToken)' member"
      )
    }
  }

  /// A stale-frame demotion must never be able to CREATE tracking. `tick` is
  /// a demotion-only path by construction; this proves it over the whole
  /// phase set rather than the one ordering the fixture happens to walk.
  func testATickNeverPromotesFromAnyPhase() {
    func strong(_ t: Int64) -> LiveVtoTrackingObservation {
      LiveVtoTrackingObservation(
        monotonicMs: t, outcome: .poseResolved, trackingConfidence: 0.9,
        geometryGatePassed: true, geometryFailure: nil, personFrameAvailable: true
      )
    }
    func degraded(_ t: Int64) -> LiveVtoTrackingObservation {
      LiveVtoTrackingObservation(
        monotonicMs: t, outcome: .poseResolved, trackingConfidence: 0.4,
        geometryGatePassed: true, geometryFailure: nil, personFrameAvailable: true
      )
    }

    for target in ["acquiring", "weak", "lost", "acquired"] {
      let machine = LiveVtoTrackingQualityMachine()
      switch target {
      case "acquired":
        for i in 0..<3 { machine.observe(strong(Int64(i) * 33)) }
      case "weak":
        for i in 0..<3 { machine.observe(strong(Int64(i) * 33)) }
        for i in 0..<2 { machine.observe(degraded(99 + Int64(i) * 33)) }
      case "lost":
        for i in 0..<3 { machine.observe(strong(Int64(i) * 33)) }
        machine.tick(monotonicMs: 5_000, personFrameAvailable: true)
      default:
        break
      }
      let before = machine.snapshot().phase
      for t: Int64 in [6_000, 6_100, 6_200, 20_000] {
        machine.tick(monotonicMs: t, personFrameAvailable: true)
      }
      let after = machine.snapshot().phase
      XCTAssertTrue(
        after == before || after == .weak || after == .lost,
        "tick promoted \(target) from \(before) to \(after)"
      )
      XCTAssertTrue(
        !machine.snapshot().captureReady || after == before,
        "tick left capture readiness on in \(after)"
      )
    }
  }
}
