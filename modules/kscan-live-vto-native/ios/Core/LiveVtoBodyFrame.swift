import Foundation

/// Native re-declaration of the research BodyFrame contract
/// (`kscan-live-vto/packages/live-vto-contract/src/bodyFrame.ts`, PR #295 @
/// `266ab1a`), field-for-field matching Android's own re-declaration in
/// `LiveVtoBodyFrame.kt`.
///
/// BodyFrame is deliberately NOT promoted to the app's shared TS layer (see
/// `docs/vto-live-integration-manifest.md`, "Deliberately not promoted") --
/// it stays native by design, on both platforms. This is a field-for-field
/// port of the Kotlin shape (itself a port of the TS shape), not an import.
///
/// Coordinates are normalized [0,1], origin top-left, front-camera-mirrored
/// (the wearer's own left is at the LOWER u) -- same convention as
/// `GarmentControlPoint`'s (u,v).
public enum Landmark: Equatable {
  case present(point: Vec2, confidence: Float)
  case absent

  public var isPresent: Bool {
    if case .present = self { return true }
    return false
  }

  public var pointOrNull: Vec2? {
    if case .present(let point, _) = self { return point }
    return nil
  }
}

public struct BodyFrame: Equatable {
  public var timestampMs: Int64
  public var headCenter: Landmark
  public var noseOrHeadDirection: Landmark
  public var neckCenter: Landmark
  public var leftShoulder: Landmark
  public var rightShoulder: Landmark
  public var leftElbow: Landmark
  public var rightElbow: Landmark
  public var leftWrist: Landmark
  public var rightWrist: Landmark
  public var chestCenter: Landmark
  public var waistCenter: Landmark
  public var leftHip: Landmark
  public var rightHip: Landmark
  public var torsoCenter: Landmark
  public var torsoWidth: Float?
  public var torsoHeight: Float?
  public var torsoRotation: Float?
  public var trackingConfidence: Float

  public init(
    timestampMs: Int64, headCenter: Landmark, noseOrHeadDirection: Landmark, neckCenter: Landmark,
    leftShoulder: Landmark, rightShoulder: Landmark, leftElbow: Landmark, rightElbow: Landmark,
    leftWrist: Landmark, rightWrist: Landmark, chestCenter: Landmark, waistCenter: Landmark,
    leftHip: Landmark, rightHip: Landmark, torsoCenter: Landmark, torsoWidth: Float?,
    torsoHeight: Float?, torsoRotation: Float?, trackingConfidence: Float
  ) {
    self.timestampMs = timestampMs
    self.headCenter = headCenter
    self.noseOrHeadDirection = noseOrHeadDirection
    self.neckCenter = neckCenter
    self.leftShoulder = leftShoulder
    self.rightShoulder = rightShoulder
    self.leftElbow = leftElbow
    self.rightElbow = rightElbow
    self.leftWrist = leftWrist
    self.rightWrist = rightWrist
    self.chestCenter = chestCenter
    self.waistCenter = waistCenter
    self.leftHip = leftHip
    self.rightHip = rightHip
    self.torsoCenter = torsoCenter
    self.torsoWidth = torsoWidth
    self.torsoHeight = torsoHeight
    self.torsoRotation = torsoRotation
    self.trackingConfidence = trackingConfidence
  }

  private static func present(_ u: Float, _ v: Float, _ confidence: Float = 1) -> Landmark {
    .present(point: Vec2(u, v), confidence: confidence)
  }

  /// Canned test pose. Values match the fixture generator's own base pose
  /// (`kscan-live-vto/packages/evaluation/src/syntheticFixtures.ts`
  /// `generateCenteredStandingSequence`'s `base`), already re-typed in
  /// Android's `BodyFrame.neutral()`. A centered, front-facing, neutral
  /// standing pose.
  ///
  /// `chestCenter`/`waistCenter`/`torsoCenter`/`torsoWidth`/`torsoHeight`/
  /// `torsoRotation` are DERIVED here (simple midpoint/distance/angle math),
  /// not part of the research canned example -- the real deformation
  /// pipeline (`LiveVtoGarmentAttachment`) computes its own anchors directly
  /// from the shoulder/hip landmarks and does not consume these derived
  /// fields, so approximating them is not load-bearing for geometry.
  public static func neutral(timestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> BodyFrame {
    let headCenter = present(0.5, 0.15)
    let neckCenter = present(0.5, 0.22)
    let leftShoulder = present(0.38, 0.28)
    let rightShoulder = present(0.62, 0.28)
    let leftElbow = present(0.32, 0.45)
    let rightElbow = present(0.68, 0.45)
    let leftWrist = present(0.3, 0.6)
    let rightWrist = present(0.7, 0.6)
    let leftHip = present(0.4, 0.6)
    let rightHip = present(0.6, 0.6)

    let shoulderMidX: Float = (0.38 + 0.62) / 2
    let shoulderMidY: Float = (0.28 + 0.28) / 2
    let hipMidX: Float = (0.4 + 0.6) / 2
    let hipMidY: Float = (0.6 + 0.6) / 2
    let torsoCenter = present((shoulderMidX + hipMidX) / 2, (shoulderMidY + hipMidY) / 2)
    let chestCenter = present(shoulderMidX, (shoulderMidY + hipMidY) / 2 * 0.5 + shoulderMidY * 0.5)
    let waistCenter = present(hipMidX, hipMidY)
    let torsoWidth: Float = 0.62 - 0.38
    let torsoHeight = Float(
      (Double(hipMidX - shoulderMidX) * Double(hipMidX - shoulderMidX)
        + Double(hipMidY - shoulderMidY) * Double(hipMidY - shoulderMidY)).squareRoot())
    let torsoRotation = atan2f(Float(0.28 - 0.28), Float(0.62 - 0.38))

    return BodyFrame(
      timestampMs: timestampMs,
      headCenter: headCenter,
      noseOrHeadDirection: .absent,
      neckCenter: neckCenter,
      leftShoulder: leftShoulder,
      rightShoulder: rightShoulder,
      leftElbow: leftElbow,
      rightElbow: rightElbow,
      leftWrist: leftWrist,
      rightWrist: rightWrist,
      chestCenter: chestCenter,
      waistCenter: waistCenter,
      leftHip: leftHip,
      rightHip: rightHip,
      torsoCenter: torsoCenter,
      torsoWidth: torsoWidth,
      torsoHeight: torsoHeight,
      torsoRotation: torsoRotation,
      trackingConfidence: 1)
  }

  /// The `arms-slightly-out` golden pose, re-declared here so the on-device
  /// replay sequence and the SwiftPM conformance goldens interpolate between
  /// the SAME two keyframes as Android's `BodyFrameKeyframeParityTest`
  /// enforces there. `LiveVtoBodyFrameKeyframeParityTests` keeps this in
  /// sync with `goldens/bodyframes.json` on the iOS side.
  public static func armsSlightlyOut(timestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> BodyFrame {
    var frame = neutral(timestampMs: timestampMs)
    frame.leftElbow = present(0.26, 0.44)
    frame.rightElbow = present(0.74, 0.44)
    frame.leftWrist = present(0.22, 0.58)
    frame.rightWrist = present(0.78, 0.58)
    return frame
  }
}

/// Normalized [0,1] BodyFrame coordinates -> a pixel-space render canvas.
public func toCanvasPx(_ v: Vec2, canvasWidth: Float, canvasHeight: Float) -> Vec2 {
  Vec2(v.x * canvasWidth, v.y * canvasHeight)
}
