import Foundation

/// Static attemptability only; frames, tracking and render success require a session.
public enum LiveVtoCapabilityStages {
  /// Flips only with physical certification and release approval.
  public static let physicalCertificationApproved = false

  public struct Inputs {
    public let platformSupported: Bool
    public let frontCameraPresent: Bool
    public let modelAssetPresent: Bool
    public let cameraPermissionGranted: Bool
    public let modelIntegrityValid: Bool
    public let rendererAvailable: Bool

    public init(
      platformSupported: Bool,
      frontCameraPresent: Bool,
      modelAssetPresent: Bool,
      cameraPermissionGranted: Bool,
      modelIntegrityValid: Bool = false,
      rendererAvailable: Bool = false
    ) {
      self.platformSupported = platformSupported
      self.frontCameraPresent = frontCameraPresent
      self.modelAssetPresent = modelAssetPresent
      self.cameraPermissionGranted = cameraPermissionGranted
      self.modelIntegrityValid = modelIntegrityValid
      self.rendererAvailable = rendererAvailable
    }
  }

  public static func evaluate(
    _ inputs: Inputs,
    runtimeVersion: String?,
    certified: Bool = physicalCertificationApproved
  ) -> [String: Any?] {
    // Hardware/platform eligibility. Permission is deliberately NOT part of it:
    // it is requested later, on an explicit customer action.
    let capable = inputs.platformSupported && inputs.frontCameraPresent && inputs.modelAssetPresent && inputs.modelIntegrityValid && inputs.rendererAvailable
    // The runtime's own resources: the governed model on top of capability.
    let runtimeReady = capable && inputs.modelAssetPresent
    let stages: [String: Any] = [
      "moduleRegistered": true,
      "platformSupported": inputs.platformSupported,
      "frontCameraPresent": inputs.frontCameraPresent,
      "modelAssetPresent": inputs.modelAssetPresent,
      "modelIntegrityValid": inputs.modelIntegrityValid,
      "rendererAvailable": inputs.rendererAvailable,
      "cameraPermission": inputs.cameraPermissionGranted ? "granted" : "not_granted",
      "physicalCertification": certified ? "approved" : "not_approved",
    ]
    return [
      "capable": capable,
      "runtimeReady": runtimeReady,
      "runtimeVersion": runtimeVersion,
      "diagnosticReasons": [
        inputs.platformSupported ? nil : "unsupported_platform",
        inputs.frontCameraPresent ? nil : "front_camera_missing",
        inputs.modelAssetPresent ? nil : "model_asset_missing",
        inputs.modelIntegrityValid ? nil : "model_integrity_failed",
        inputs.rendererAvailable ? nil : "renderer_unavailable",
      ].compactMap { $0 },
      "stages": stages,
    ]
  }
}
