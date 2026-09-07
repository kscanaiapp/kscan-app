import Foundation

/// The truthful answer to `getCapability()` -- the Swift mirror of Android's
/// `LiveVtoRuntimeCapability.kt`.
///
/// WHY THIS FILE EXISTS. `getCapability()` returned a HARDCODED
/// `capable=false, runtimeReady=false` on both platforms -- correct at N1-A,
/// when registration was all that existed, and left in place through the
/// gates that actually built the runtime. The consequence was total:
/// `services/vto/vtoLiveCapability.ts` reads exactly these two fields, so
/// every build in existence resolved Live to `device_unsupported` before any
/// other gate was consulted. Live could not be offered to a customer on any
/// device, in any environment, however the feature flag or the operator
/// switch were set.
///
/// THE OPPOSITE MISTAKE IS WORSE, SO THIS IS EVIDENCE-BASED. The fix is not
/// to hardcode `true` -- that is the "registration is not capability" error
/// the JS adapter's own header warns about. Every field is a real, checkable
/// device fact gathered at call time by the Expo module; this file is the
/// pure decision over them, so the whole truth table runs under `swift test`
/// with no device.
///
/// FAIL CLOSED. The module wraps its evidence gathering and passes
/// `.unknown` on any failure, which resolves to a flat no.
public struct LiveVtoCapabilityEvidence: Equatable, Sendable {
  /// Major iOS version. Live is a front-camera + on-device-inference feature
  /// and the podspec's own deployment target is the floor.
  public let osMajorVersion: Int
  /// A front-facing capture device was actually discovered. Live is a
  /// front-camera feature; a device without one cannot run it however fast
  /// it is.
  public let hasFrontCamera: Bool
  /// The bundled pose-landmarker model was located in the resource bundle.
  /// Not "declared in the registry" -- actually resolved.
  public let poseModelPresent: Bool
  /// How many governed `.ksgarment` asset directories parsed successfully. A
  /// runtime with no loadable garment cannot render anything.
  public let governedAssetCount: Int

  public init(osMajorVersion: Int, hasFrontCamera: Bool, poseModelPresent: Bool, governedAssetCount: Int) {
    self.osMajorVersion = osMajorVersion
    self.hasFrontCamera = hasFrontCamera
    self.poseModelPresent = poseModelPresent
    self.governedAssetCount = governedAssetCount
  }

  /// What the module reports when its own evidence gathering threw.
  public static let unknown = LiveVtoCapabilityEvidence(
    osMajorVersion: 0, hasFrontCamera: false, poseModelPresent: false, governedAssetCount: 0
  )
}

public enum LiveVtoRuntimeCapability {
  /// `KScanLiveVtoNative.podspec`'s own `:ios => '15.1'` deployment target,
  /// restated rather than derived. Nothing here needs a HIGHER floor than the
  /// module already compiles against, and inventing one would refuse Live on
  /// devices that can genuinely run it.
  public static let minOSMajorVersion = 15

  /// One loadable governed asset is the minimum a renderer needs.
  public static let minGovernedAssets = 1

  /// Can this DEVICE run Live at all.
  public static func capable(_ evidence: LiveVtoCapabilityEvidence) -> Bool {
    evidence.osMajorVersion >= minOSMajorVersion && evidence.hasFrontCamera
  }

  /// Are this RUNTIME's own resources ready. Deliberately implies `capable`:
  /// `isLiveVtoNativeCapable` requires both, and a runtime reporting "ready"
  /// on a device it cannot run on would be a contradiction a consumer might
  /// resolve the wrong way.
  public static func runtimeReady(_ evidence: LiveVtoCapabilityEvidence) -> Bool {
    capable(evidence)
      && evidence.poseModelPresent
      && evidence.governedAssetCount >= minGovernedAssets
  }
}
