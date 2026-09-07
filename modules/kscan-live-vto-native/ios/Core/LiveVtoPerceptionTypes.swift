import Foundation

/// The provider-agnostic perception contract. Field-for-field port of
/// Android's `LiveVtoPerceptionTypes.kt`.
///
/// Every real pose provider (MediaPipe today; anything else later) sits
/// behind this interface. Nothing provider-specific -- no MediaPipe type, no
/// vendor landmark index, no vendor confidence convention -- may escape past
/// `LiveVtoBodyFrameAdapter` into the renderer, the replay runtime, or the JS
/// bridge.
///
/// `RawPoseFrame` is that boundary: it is this module's OWN minimal,
/// provider-agnostic shape, not a copy of any vendor's result type. A
/// provider implementation's only job is to translate its native result into
/// this shape; the adapter that turns `RawPoseFrame` into a governed
/// `BodyFrame` never touches a provider SDK type at all, which is what keeps
/// it runnable in a plain SwiftPM host test.

/// One landmark in normalized image-space [0,1], provider-reported confidence, and whether observed at all.
public struct RawPoseLandmark {
  public let x: Float
  public let y: Float
  public let confidence: Float
  /// True if the provider reported a value (however low-confidence). False = genuinely not observed this frame.
  public let present: Bool

  public init(x: Float, y: Float, confidence: Float, present: Bool) {
    self.x = x
    self.y = y
    self.confidence = confidence
    self.present = present
  }
}

/// One inference result, indexed by the BlazePose/MediaPipe Pose 33-point
/// topology (stable across MediaPipe Tasks versions on both platforms; the
/// same public model documentation Android's `PoseLandmarkIndex` cites, not
/// independently re-derived here). Index absence at a position that topology
/// does not define is invalid; an ABSENT landmark is
/// `RawPoseLandmark(present: false, ...)`, never a missing array entry.
public struct RawPoseFrame {
  public let timestampMs: Int64
  public let landmarks: [RawPoseLandmark]
  /// Overall per-pose detection confidence from the provider, if it reports one.
  public let poseConfidence: Float

  public init(timestampMs: Int64, landmarks: [RawPoseLandmark], poseConfidence: Float) {
    self.timestampMs = timestampMs
    self.landmarks = landmarks
    self.poseConfidence = poseConfidence
  }
}

/// BlazePose/MediaPipe Pose 33-point topology indices this adapter actually consumes.
public enum PoseLandmarkIndex {
  public static let nose = 0
  public static let leftShoulder = 11
  public static let rightShoulder = 12
  public static let leftElbow = 13
  public static let rightElbow = 14
  public static let leftWrist = 15
  public static let rightWrist = 16
  public static let leftHip = 23
  public static let rightHip = 24
  public static let count = 33
}

public enum PerceptionState: String {
  case uninitialized = "UNINITIALIZED"
  case initializing = "INITIALIZING"
  case ready = "READY"
  case processing = "PROCESSING"
  case error = "ERROR"
  case disposed = "DISPOSED"
}

/// Truthful, evidence-backed capability. `moduleAvailable` is a compile/link
/// fact; `perceptionReady` requires the model to have actually loaded. Never
/// report `perceptionReady: true` before that has genuinely happened.
public struct PerceptionCapability {
  public let moduleAvailable: Bool
  public let perceptionReady: Bool
  public let providerName: String
  public let modelName: String
  public let reason: String?

  public init(moduleAvailable: Bool, perceptionReady: Bool, providerName: String, modelName: String, reason: String?) {
    self.moduleAvailable = moduleAvailable
    self.perceptionReady = perceptionReady
    self.providerName = providerName
    self.modelName = modelName
    self.reason = reason
  }
}

/// One frame's inference outcome, including the fail-closed paths.
public enum PerceptionResult {
  case success(frame: RawPoseFrame)
  /// The provider ran but found no pose, or explicitly reported failure -- not the same as a thrown error.
  case noPose(reason: String)
  /// `initialize()`/`processFrame()` threw, or was called out of sequence. Never crashes the caller.
  case failure(reason: String)
}

/// The provider contract every real pose backend implements.
///
/// Lifecycle is strict: `initialize()` must complete (and return `true`)
/// before `processFrame()` is called; `processFrame()` after `dispose()` must
/// fail closed, never trap and never silently reuse a disposed native
/// handle.
public protocol PerceptionProvider: AnyObject {
  func initialize() -> Bool
  func getCapability() -> PerceptionCapability
  func processFrame(_ frame: PerceptionInputFrame) -> PerceptionResult
  func reset()
  func dispose()
}

/// A provider-agnostic input frame. Deliberately NOT a `CVPixelBuffer`/`UIImage`
/// reference held here -- the protocol is defined in terms of raw pixels so
/// the CONTRACT stays testable independent of any specific image type, even
/// though every real implementation today is UIKit/Vision-backed.
public protocol PerceptionInputFrame {
  var width: Int { get }
  var height: Int { get }
}
