import Foundation
import UIKit
import CryptoKit
import MediaPipeTasksVision

/// iOS `PerceptionProvider` backed by MediaPipe Tasks Vision Pose Landmarker.
/// Structural port of Android's `LiveVtoMediaPipePoseProvider.kt`, adapted to
/// the iOS MediaPipe Tasks Vision Swift API (`pod 'MediaPipeTasksVision'`,
/// verified current at `1.0.0` against CocoaPods trunk on 2026-09-06 --
/// the same version Android's `com.google.mediapipe:tasks-vision:1.0.0`
/// pins, so both platforms run the identical provider release).
///
/// `translate(_:)` below is the ONLY place in this file that touches a
/// MediaPipe result type, exactly like Android's own provider -- everything
/// past that boundary is the provider-agnostic `RawPoseFrame` the shared
/// `LiveVtoBodyFrameAdapter` (in `ios/Core/`, zero MediaPipe imports)
/// consumes.
public final class LiveVtoMediaPipePoseProvider: PerceptionProvider {
  public static let providerName = "mediapipe-tasks-vision-pose-landmarker"
  public static let modelName = "pose_landmarker_lite"
  static let modelResourceName = "pose_landmarker_lite"
  static let modelResourceExtension = "task"

  /// Must match `config/on-device-model-authority.json`'s `approvedModels[0].sha256`
  /// -- the SAME governed model file as Android, bundled for iOS under
  /// `ios/Assets/models/pose_landmarker_lite.task`. Checked at `initialize()`
  /// time, not merely recorded in documentation: an unexpected or corrupted
  /// model asset fails closed rather than silently loading.
  static let approvedModelSha256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"

  private var landmarker: PoseLandmarker?
  private var lastFailureReason: String?

  public init() {}

  public func initialize() -> Bool {
    guard let modelPath = LiveVtoAssetBundle.shared
      .path(forResource: Self.modelResourceName, ofType: Self.modelResourceExtension, inDirectory: "models")
    else {
      lastFailureReason = "bundled model asset not found: \(Self.modelResourceName).\(Self.modelResourceExtension)"
      return false
    }

    guard let modelData = FileManager.default.contents(atPath: modelPath) else {
      lastFailureReason = "could not read bundled model asset at \(modelPath)"
      return false
    }
    let digest = SHA256.hash(data: modelData).map { String(format: "%02x", $0) }.joined()
    guard digest == Self.approvedModelSha256 else {
      // FAIL CLOSED. A changed or unexpected model must never load -- see
      // config/on-device-model-authority.json's fail-closed policy, enforced
      // here at the runtime/loader level, not only recorded in a manifest.
      lastFailureReason = "bundled model checksum mismatch: expected \(Self.approvedModelSha256), got \(digest)"
      return false
    }

    let options = PoseLandmarkerOptions()
    options.baseOptions.modelAssetPath = modelPath
    // Single-frame diagnostic mode -- not .liveStream, matching Android's
    // RunningMode.IMAGE for this same catch-up scope; a live camera pipeline
    // is explicitly out of scope for this lane.
    options.runningMode = .image
    options.numPoses = 1
    options.minPoseDetectionConfidence = 0.5
    options.minPosePresenceConfidence = 0.5
    options.minTrackingConfidence = 0.5
    // Segmentation masks never requested -- this provider produces landmarks
    // only, exactly like Android's setOutputSegmentationMasks(false).

    do {
      landmarker = try PoseLandmarker(options: options)
      lastFailureReason = nil
      return true
    } catch {
      lastFailureReason = "PoseLandmarker init failed: \(error)"
      return false
    }
  }

  public func getCapability() -> PerceptionCapability {
    PerceptionCapability(
      moduleAvailable: true,
      perceptionReady: landmarker != nil,
      providerName: Self.providerName,
      modelName: Self.modelName,
      reason: lastFailureReason)
  }

  public func processFrame(_ frame: PerceptionInputFrame) -> PerceptionResult {
    guard let landmarker = landmarker else {
      return .failure(reason: "processFrame called before a successful initialize()")
    }
    guard let imageFrame = frame as? LiveVtoStaticImageFrame else {
      return .failure(reason: "unsupported PerceptionInputFrame type: \(type(of: frame))")
    }

    do {
      let mpImage = try MPImage(uiImage: imageFrame.image)
      let result = try landmarker.detect(image: mpImage)
      return translate(result, timestampMs: Int64(Date().timeIntervalSince1970 * 1000))
    } catch {
      return .failure(reason: "PoseLandmarker.detect threw: \(error)")
    }
  }

  public func reset() {
    // Stateless per-frame detection in .image running mode -- nothing to reset between frames.
  }

  public func dispose() {
    landmarker = nil
  }

  /// The ONLY place this file touches a MediaPipe result type. Maps
  /// `PoseLandmarkerResult` -> the provider-agnostic `RawPoseFrame`.
  private func translate(_ result: PoseLandmarkerResult, timestampMs: Int64) -> PerceptionResult {
    guard let landmarks = result.landmarks.first, !landmarks.isEmpty else {
      return .noPose(reason: "no pose detected")
    }
    let raw = landmarks.map { lm in
      RawPoseLandmark(x: Float(lm.x), y: Float(lm.y), confidence: Float(lm.visibility?.floatValue ?? 1), present: true)
    }
    // MediaPipe Tasks Vision does not report a separate overall pose-level
    // confidence distinct from per-landmark visibility/presence on this
    // platform's API surface; using the minimum per-landmark confidence as
    // the frame-level figure is a conservative (never-overstate) stand-in,
    // consistent with how `LiveVtoBodyFrameAdapter` already treats missing
    // per-landmark confidence elsewhere.
    let poseConfidence = raw.map(\.confidence).min() ?? 0
    return .success(frame: RawPoseFrame(timestampMs: timestampMs, landmarks: raw, poseConfidence: poseConfidence))
  }
}

/// The iOS `PerceptionInputFrame` this provider actually consumes. Wraps a
/// `UIImage` directly rather than Android's raw-`Bitmap`-via-`Canvas`
/// approach, since `MPImage(uiImage:)` is the documented MediaPipe Tasks
/// Vision iOS entry point.
public struct LiveVtoStaticImageFrame: PerceptionInputFrame {
  public let image: UIImage
  public var width: Int { Int(image.size.width * image.scale) }
  public var height: Int { Int(image.size.height * image.scale) }

  public init(image: UIImage) {
    self.image = image
  }
}

/// Repeats one bundled synthetic image. Procedurally generated at build time
/// (see `docs/vto-live-bridge-contract.md`), zero person imagery -- same
/// provenance discipline as Android's `StaticBitmapFrameSource`.
public final class LiveVtoStaticImageFrameSource {
  private let image: UIImage
  public init(image: UIImage) { self.image = image }
  public func callAsFunction() -> PerceptionInputFrame { LiveVtoStaticImageFrame(image: image) }
}
