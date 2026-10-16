package expo.modules.kscanlivevtonative

/**
 * What the module can truthfully say about itself BEFORE a session exists.
 *
 * Pure and Android-free, so every rule here is unit-tested without a device.
 *
 * REGISTRATION IS NOT CAPABILITY, AND CAPABILITY IS NOT A WORKING CAMERA. The
 * facts below are the static prerequisites. They are reported as separate
 * stages so a reader can see exactly which one is missing, and none of them is
 * ever collapsed into "it works":
 *
 *   moduleRegistered   always true if this code runs
 *   platformSupported  OS level the runtime's dependencies support
 *   frontCameraPresent the hardware exists
 *   modelAssetPresent  the governed pose model is in the APK's assets
 *   cameraPermission   current OS state (granted / not_granted); not requested here
 *
 * STAGES THAT CANNOT BE KNOWN HERE, and are therefore NOT reported by this
 * function: camera session initialized, frames delivered, frames consumed,
 * perception functioning, renderer producing visible output. Those are only
 * provable after `start()` and are reported by the session's bounded runtime
 * events (camera/perception counters), never inferred up front.
 *
 * THE CERTIFICATION GATE. `capable` and `runtimeReady` stay false while
 * [PHYSICAL_CERTIFICATION_APPROVED] is false, whatever the stages say: this
 * pipeline has never delivered a frame on the certified device (historical
 * `ETIMEDOUT -110`), and file presence or registration must not advertise a
 * working camera. Changing that constant is a reviewed release decision that
 * needs physical-device evidence; it is not a fix for anything.
 */
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
  )

  fun evaluate(
    inputs: Inputs,
    runtimeVersion: String?,
    certified: Boolean = PHYSICAL_CERTIFICATION_APPROVED,
  ): Map<String, Any?> {
    val platformSupported = inputs.sdkInt >= MIN_SDK_INT
    // Hardware/platform eligibility. Permission is deliberately NOT part of it:
    // it is requested later, on an explicit customer action.
    val capable = certified && platformSupported && inputs.frontCameraPresent
    // The runtime's own resources. Needs the governed model on top of capability.
    val runtimeReady = capable && inputs.modelAssetPresent
    return mapOf(
      "capable" to capable,
      "runtimeReady" to runtimeReady,
      "runtimeVersion" to runtimeVersion,
      "stages" to mapOf(
        "moduleRegistered" to true,
        "platformSupported" to platformSupported,
        "frontCameraPresent" to inputs.frontCameraPresent,
        "modelAssetPresent" to inputs.modelAssetPresent,
        "cameraPermission" to if (inputs.cameraPermissionGranted) "granted" else "not_granted",
        "physicalCertification" to if (certified) "approved" else "not_approved",
      ),
    )
  }
}
