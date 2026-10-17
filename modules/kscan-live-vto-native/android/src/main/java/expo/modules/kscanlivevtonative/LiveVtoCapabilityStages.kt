package expo.modules.kscanlivevtonative

/** Static attemptability only; frames, tracking and render success require a session. */
object LiveVtoCapabilityStages {
  /** Flips only with physical certification and release approval. */
  const val PHYSICAL_CERTIFICATION_APPROVED = false

  /** Lowest SDK level MediaPipe Tasks Vision and CameraX are both supported on. */
  const val MIN_SDK_INT = 24

  data class Inputs(
    val sdkInt: Int,
    val frontCameraPresent: Boolean,
    val modelAssetPresent: Boolean,
    val cameraPermissionGranted: Boolean,
    val modelIntegrityValid: Boolean = false,
    val rendererAvailable: Boolean = false,
  )

  fun evaluate(
    inputs: Inputs,
    runtimeVersion: String?,
    certified: Boolean = PHYSICAL_CERTIFICATION_APPROVED,
  ): Map<String, Any?> {
    val platformSupported = inputs.sdkInt >= MIN_SDK_INT
    // Hardware/platform eligibility. Permission is deliberately NOT part of it:
    // it is requested later, on an explicit customer action.
    val capable = platformSupported && inputs.frontCameraPresent && inputs.modelAssetPresent && inputs.modelIntegrityValid && inputs.rendererAvailable
    // The runtime's own resources. Needs the governed model on top of capability.
    val runtimeReady = capable && inputs.modelAssetPresent
    return mapOf(
      "capable" to capable,
      "runtimeReady" to runtimeReady,
      "runtimeVersion" to runtimeVersion,
      "diagnosticReasons" to listOfNotNull(
        if (!platformSupported) "unsupported_platform" else null,
        if (!inputs.frontCameraPresent) "front_camera_missing" else null,
        if (!inputs.modelAssetPresent) "model_asset_missing" else null,
        if (!inputs.modelIntegrityValid) "model_integrity_failed" else null,
        if (!inputs.rendererAvailable) "renderer_unavailable" else null,
      ),
      "stages" to mapOf(
        "moduleRegistered" to true,
        "platformSupported" to platformSupported,
        "frontCameraPresent" to inputs.frontCameraPresent,
        "modelAssetPresent" to inputs.modelAssetPresent,
        "modelIntegrityValid" to inputs.modelIntegrityValid,
        "rendererAvailable" to inputs.rendererAvailable,
        "cameraPermission" to if (inputs.cameraPermissionGranted) "granted" else "not_granted",
        "physicalCertification" to if (certified) "approved" else "not_approved",
      ),
    )
  }
}
