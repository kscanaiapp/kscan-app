package expo.modules.kscanlivevtonative

/**
 * The truthful answer to `getCapability()`.
 *
 * WHY THIS FILE EXISTS. `getCapability()` returned a HARDCODED
 * `capable=false, runtimeReady=false` on both platforms -- correct at N1-A,
 * when registration was all that existed, and left in place through N1-B..G
 * after the runtime it describes was actually built. The consequence was
 * total: `services/vto/vtoLiveCapability.ts` reads exactly these two fields,
 * so every build in existence resolved Live to `device_unsupported` before
 * any other gate was consulted. Live could not be offered to a customer on
 * any device, in any environment, no matter how the feature flag or the
 * operator switch were set. The customer path was dark by construction.
 *
 * THE OPPOSITE MISTAKE IS WORSE, SO THIS IS EVIDENCE-BASED. The fix is not
 * to hardcode `true` -- that is the "registration is not capability" error
 * `services/vto/liveVtoNativeModule.ts`'s own header warns about, and it
 * would hand a customer a Live surface on a device with no front camera or
 * no bundled model. Every field below is a real, checkable device fact
 * gathered at call time by the Expo module (the Android boundary), and this
 * file is the pure decision over them so the whole truth table is testable
 * on the JVM with no device.
 *
 * FAIL CLOSED. The module wraps its evidence gathering in try/catch and
 * passes [UNKNOWN] on any failure, which resolves to a flat no. An
 * unanswerable capability question is answered "no", exactly as the JS
 * adapter already does for a module that throws.
 */
data class LiveVtoCapabilityEvidence(
  /** `Build.VERSION.SDK_INT`. */
  val sdkInt: Int,
  /** `PackageManager.FEATURE_CAMERA_FRONT`. Live is a front-camera feature;
   *  a device without one cannot run it however fast it is. */
  val hasFrontCamera: Boolean,
  /** The bundled pose-landmarker model opened successfully from APK assets.
   *  Not "the file is declared in the registry" -- actually opened. */
  val poseModelPresent: Boolean,
  /** How many governed `.ksgarment` asset directories parsed successfully.
   *  A runtime with no loadable garment cannot render anything. */
  val governedAssetCount: Int,
) {
  companion object {
    /** What the module reports when its own evidence gathering threw. */
    val UNKNOWN = LiveVtoCapabilityEvidence(
      sdkInt = 0, hasFrontCamera = false, poseModelPresent = false, governedAssetCount = 0,
    )
  }
}

object LiveVtoRuntimeCapability {
  /**
   * The application's own Android floor (Expo's `expo-root-project` default
   * for this SDK line), restated rather than derived: both the MediaPipe
   * Tasks Vision 1.0.0 artifact and CameraX 1.6.2 support it, so nothing
   * here needs a HIGHER floor than the app already has -- and inventing one
   * would refuse Live on devices that can genuinely run it.
   */
  const val MIN_SDK_INT = 24

  /** One loadable governed asset is the minimum a renderer needs. */
  const val MIN_GOVERNED_ASSETS = 1

  /** Can this DEVICE run Live at all. */
  fun capable(evidence: LiveVtoCapabilityEvidence): Boolean =
    evidence.sdkInt >= MIN_SDK_INT && evidence.hasFrontCamera

  /**
   * Are this RUNTIME's own resources ready. Deliberately implies [capable]:
   * `services/vto/liveVtoNativeModule.ts`'s `isLiveVtoNativeCapable` requires
   * both, and a runtime reporting "ready" on a device it cannot run on would
   * be a contradiction a consumer might resolve the wrong way.
   */
  fun runtimeReady(evidence: LiveVtoCapabilityEvidence): Boolean =
    capable(evidence) &&
      evidence.poseModelPresent &&
      evidence.governedAssetCount >= MIN_GOVERNED_ASSETS
}
