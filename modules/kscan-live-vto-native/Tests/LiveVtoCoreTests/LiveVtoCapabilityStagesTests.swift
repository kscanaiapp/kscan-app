import XCTest
@testable import LiveVtoCore

/// Port of Android's `LiveVtoCapabilityStagesTest.kt`.
final class LiveVtoCapabilityStagesTests: XCTestCase {

  private let allGood = LiveVtoCapabilityStages.Inputs(
    platformSupported: true, frontCameraPresent: true, modelAssetPresent: true, cameraPermissionGranted: true, modelIntegrityValid: true, rendererAvailable: true
  )

  private func stages(_ result: [String: Any?]) -> [String: Any] {
    (result["stages"] as? [String: Any]) ?? [:]
  }

  func testTheShippedGateIsClosed() {
    XCTAssertFalse(LiveVtoCapabilityStages.physicalCertificationApproved)
  }

  func testUncertifiedRuntimeCanAttemptARealSession() {
    let result = LiveVtoCapabilityStages.evaluate(allGood, runtimeVersion: "n1-a-ios")
    XCTAssertEqual(result["capable"] as? Bool, true)
    XCTAssertEqual(result["runtimeReady"] as? Bool, true)
    let s = stages(result)
    XCTAssertEqual(s["moduleRegistered"] as? Bool, true)
    XCTAssertEqual(s["platformSupported"] as? Bool, true)
    XCTAssertEqual(s["frontCameraPresent"] as? Bool, true)
    XCTAssertEqual(s["modelAssetPresent"] as? Bool, true)
    XCTAssertEqual(s["cameraPermission"] as? String, "granted")
    XCTAssertEqual(s["physicalCertification"] as? String, "not_approved")
  }

  func testStagesReportTheMissingPrerequisiteIndividually() {
    let noModel = stages(LiveVtoCapabilityStages.evaluate(
      .init(platformSupported: true, frontCameraPresent: true, modelAssetPresent: false, cameraPermissionGranted: true, modelIntegrityValid: true, rendererAvailable: true),
      runtimeVersion: nil))
    XCTAssertEqual(noModel["modelAssetPresent"] as? Bool, false)
    XCTAssertEqual(noModel["frontCameraPresent"] as? Bool, true)
    let noPermission = stages(LiveVtoCapabilityStages.evaluate(
      .init(platformSupported: true, frontCameraPresent: true, modelAssetPresent: true, cameraPermissionGranted: false, modelIntegrityValid: true, rendererAvailable: true),
      runtimeVersion: nil))
    XCTAssertEqual(noPermission["cameraPermission"] as? String, "not_granted")
  }

  func testWhenApprovedEveryPrerequisiteIsStillRequired() {
    let ok = LiveVtoCapabilityStages.evaluate(allGood, runtimeVersion: "v", certified: true)
    XCTAssertEqual(ok["capable"] as? Bool, true)
    XCTAssertEqual(ok["runtimeReady"] as? Bool, true)
    let noModel = LiveVtoCapabilityStages.evaluate(
      .init(platformSupported: true, frontCameraPresent: true, modelAssetPresent: false, cameraPermissionGranted: true, modelIntegrityValid: true, rendererAvailable: true),
      runtimeVersion: "v", certified: true)
    XCTAssertEqual(noModel["capable"] as? Bool, false)
    XCTAssertEqual(noModel["runtimeReady"] as? Bool, false)
    let noCamera = LiveVtoCapabilityStages.evaluate(
      .init(platformSupported: true, frontCameraPresent: false, modelAssetPresent: true, cameraPermissionGranted: true, modelIntegrityValid: true, rendererAvailable: true),
      runtimeVersion: "v", certified: true)
    XCTAssertEqual(noCamera["capable"] as? Bool, false)
    XCTAssertEqual(noCamera["runtimeReady"] as? Bool, false)
    let oldOS = LiveVtoCapabilityStages.evaluate(
      .init(platformSupported: false, frontCameraPresent: true, modelAssetPresent: true, cameraPermissionGranted: true, modelIntegrityValid: true, rendererAvailable: true),
      runtimeVersion: "v", certified: true)
    XCTAssertEqual(oldOS["capable"] as? Bool, false)
  }

  func testCameraPermissionIsNotACapabilityInput() {
    let r = LiveVtoCapabilityStages.evaluate(
      .init(platformSupported: true, frontCameraPresent: true, modelAssetPresent: true, cameraPermissionGranted: false, modelIntegrityValid: true, rendererAvailable: true),
      runtimeVersion: "v", certified: true)
    XCTAssertEqual(r["capable"] as? Bool, true)
  }

  func testUnknownStaticPrerequisitesFailClosed() {
    let report = LiveVtoCapabilityStages.evaluate(.init(platformSupported: true, frontCameraPresent: true,
      modelAssetPresent: true, cameraPermissionGranted: true), runtimeVersion: nil)
    XCTAssertEqual(report["runtimeReady"] as? Bool, false)
    XCTAssertEqual(report["diagnosticReasons"] as? [String], ["model_integrity_failed", "renderer_unavailable"])
  }

  func testNoPostStartStageIsReportedBeforeAnySessionExists() {
    let keys = Set(stages(LiveVtoCapabilityStages.evaluate(allGood, runtimeVersion: "v")).keys)
    for forbidden in ["framesDelivered", "framesConsumed", "perceptionFunctioning", "rendererPainting", "cameraSessionInitialized"] {
      XCTAssertFalse(keys.contains(forbidden), "\(forbidden) cannot be known before start()")
    }
  }
}
