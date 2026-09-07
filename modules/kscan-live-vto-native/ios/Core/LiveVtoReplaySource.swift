import Foundation

/// The deterministic synthetic replay source. Field-for-field port of
/// Android's `LiveVtoReplaySource.kt`.
///
/// PROVENANCE. Every pose in every sequence is derived, by interpolation
/// only, from the committed golden BodyFrames -- themselves named
/// perturbations of the research fixture generator's own base standing pose.
/// There is no recorded video, no person imagery, and no licensed media
/// anywhere in this path, so nothing here carries a rights question.
///
/// Each frame index yields a DIFFERENT pose, so every frame runs a full
/// geometry computation and publishes a distinct snapshot, exactly as camera
/// frames will.
public final class InterpolatedPoseReplaySource: ReplayFrameSource {
  public let id: String
  private let keyframes: [BodyFrame]
  private let framesPerSegment: Int

  public let frameCount: Int

  public init(id: String, keyframes: [BodyFrame], framesPerSegment: Int) {
    precondition(keyframes.count >= 2, "a replay sequence needs at least two keyframes")
    precondition(framesPerSegment >= 1, "framesPerSegment must be positive")
    self.id = id
    self.keyframes = keyframes
    self.framesPerSegment = framesPerSegment
    self.frameCount = (keyframes.count - 1) * framesPerSegment + 1
  }

  public func frameAt(_ index: Int) -> ReplayFrame {
    precondition(index >= 0 && index < frameCount, "frame index \(index) out of range 0..\(frameCount - 1)")
    let segment = min(index / framesPerSegment, keyframes.count - 2)
    let t = Float(index - segment * framesPerSegment) / Float(framesPerSegment)
    return ReplayFrame(index: index, frame: Self.interpolate(keyframes[segment], keyframes[segment + 1], t))
  }

  private static func interpolate(_ a: BodyFrame, _ b: BodyFrame, _ t: Float) -> BodyFrame {
    func mix(_ x: Landmark, _ y: Landmark) -> Landmark {
      guard case .present(let px, _) = x, case .present(let py, _) = y else { return .absent }
      return .present(point: Vec2(px.x + (py.x - px.x) * t, px.y + (py.y - px.y) * t), confidence: 1)
    }
    var out = a
    out.headCenter = mix(a.headCenter, b.headCenter)
    out.neckCenter = mix(a.neckCenter, b.neckCenter)
    out.leftShoulder = mix(a.leftShoulder, b.leftShoulder)
    out.rightShoulder = mix(a.rightShoulder, b.rightShoulder)
    out.leftElbow = mix(a.leftElbow, b.leftElbow)
    out.rightElbow = mix(a.rightElbow, b.rightElbow)
    out.leftWrist = mix(a.leftWrist, b.leftWrist)
    out.rightWrist = mix(a.rightWrist, b.rightWrist)
    out.leftHip = mix(a.leftHip, b.leftHip)
    out.rightHip = mix(a.rightHip, b.rightHip)
    return out
  }
}
