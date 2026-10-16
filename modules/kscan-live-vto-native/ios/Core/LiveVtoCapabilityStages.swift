import Foundation

/// What the module can truthfully say about itself BEFORE a session exists.
///
/// Pure (Foundation only), so every rule is covered by `swift test` without a
/// device. Counterpart of Android's `LiveVtoCapabilityStages.kt`; the two must
/// stay in step.
///
/// REGISTRATION IS NOT CAPABILITY, AND CAPABILITY IS NOT A WORKING CAMERA. The
/// facts are STATIC prerequisites, reported as separate stages so a reader can
/// see which one is missing and none is ever collapsed into "it works":
/// moduleRegistered, platformSupported, frontCameraPresent, modelAssetPresent,
/// cameraPermission (current OS state, not requested here), physicalCertification.
///
/// NOT reported, because it cannot be known before a session starts: camera
/// session initialized, frames delivered, frames consumed, perception
/// functioning, renderer producing visible output. Those come only from the
/// session's bounded runtime events.
///
/// `capable` and `runtimeReady` stay false while `physicalCertificationApproved`
/// is false, whatever the stages say. Changing that constant is a reviewed
/// release decision that needs physical-device evidence on iOS; it fixes nothing.
public enum LiveVtoCapabilityStages {
  /// Flips only with physical certification and release approval.
  public static let physicalCertificationApproved = false

  public struct Inputs {
    public let platformSupported: Bool
    public let frontCameraPresent: Bool
    public let modelAssetPresent: Bool
    public let cameraPermissionGranted: Bool

    public init(
      platformSupported: Bool,
      frontCameraPresent: Bool,
      modelAssetPresent: Bool,
      cameraPermissionGranted: Bool
    ) {
      self.platformSupported = platformSupported
      self.frontCameraPresent = frontCameraPresent
      self.modelAssetPresent = modelAssetPresent
      self.cameraPermissionGranted = cameraPermissionGranted
    }
  }

  public static func evaluate(
    _ inputs: Inputs,
    runtimeVersion: String?,
    certified: Bool = physicalCertificationApproved
  ) -> [String: Any?] {
    // Hardware/platform eligibility. Permission is deliberately NOT part of it:
    // it is requested later, on an explicit customer action.
    let capable = certified && inputs.platformSupported && inputs.frontCameraPresent
    // The runtime's own resources: the governed model on top of capability.
    let runtimeReady = capable && inputs.modelAssetPresent
    let stages: [String: Any] = [
      "moduleRegistered": true,
      "platformSupported": inputs.platformSupported,
      "frontCameraPresent": inputs.frontCameraPresent,
      "modelAssetPresent": inputs.modelAssetPresent,
      "cameraPermission": inputs.cameraPermissionGranted ? "granted" : "not_granted",
      "physicalCertification": certified ? "approved" : "not_approved",
    ]
    return [
      "capable": capable,
      "runtimeReady": runtimeReady,
      "runtimeVersion": runtimeVersion,
      "stages": stages,
    ]
  }
}
