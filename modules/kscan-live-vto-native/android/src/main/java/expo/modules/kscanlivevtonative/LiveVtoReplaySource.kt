package expo.modules.kscanlivevtonative

/**
 * The deterministic synthetic replay source (mission section 17).
 *
 * PROVENANCE. Every pose in every sequence is derived, by interpolation
 * only, from the committed golden BodyFrames -- themselves named
 * perturbations of the research fixture generator's own base standing pose.
 * There is no recorded video, no person imagery, and no licensed media
 * anywhere in this path, so nothing here carries a rights question.
 *
 * Mission section 17 permits a deterministic native frame sequence for stage
 * D1 provided it exercises the real frame loop rather than replaying one
 * static screenshot. It does: each frame index yields a DIFFERENT pose, so
 * every frame runs a full geometry computation and publishes a distinct
 * snapshot, exactly as camera frames will.
 */
class InterpolatedPoseReplaySource(
  override val id: String,
  private val keyframes: List<BodyFrame>,
  private val framesPerSegment: Int,
) : ReplayFrameSource {

  init {
    require(keyframes.size >= 2) { "a replay sequence needs at least two keyframes" }
    require(framesPerSegment >= 1) { "framesPerSegment must be positive" }
  }

  override val frameCount: Int = (keyframes.size - 1) * framesPerSegment + 1

  override fun frameAt(index: Int): ReplayFrame {
    require(index in 0 until frameCount) { "frame index $index out of range 0..${frameCount - 1}" }
    val segment = (index / framesPerSegment).coerceAtMost(keyframes.size - 2)
    val t = (index - segment * framesPerSegment).toFloat() / framesPerSegment
    return ReplayFrame(index, interpolate(keyframes[segment], keyframes[segment + 1], t))
  }

  private fun interpolate(a: BodyFrame, b: BodyFrame, t: Float): BodyFrame {
    fun mix(x: Landmark, y: Landmark): Landmark {
      val px = (x as? Landmark.Present)?.point ?: return Landmark.Absent
      val py = (y as? Landmark.Present)?.point ?: return Landmark.Absent
      return Landmark.Present(Vec2(px.x + (py.x - px.x) * t, px.y + (py.y - px.y) * t), 1f)
    }
    return a.copy(
      timestampMs = a.timestampMs,
      headCenter = mix(a.headCenter, b.headCenter),
      neckCenter = mix(a.neckCenter, b.neckCenter),
      leftShoulder = mix(a.leftShoulder, b.leftShoulder),
      rightShoulder = mix(a.rightShoulder, b.rightShoulder),
      leftElbow = mix(a.leftElbow, b.leftElbow),
      rightElbow = mix(a.rightElbow, b.rightElbow),
      leftWrist = mix(a.leftWrist, b.leftWrist),
      rightWrist = mix(a.rightWrist, b.rightWrist),
      leftHip = mix(a.leftHip, b.leftHip),
      rightHip = mix(a.rightHip, b.rightHip),
    )
  }
}
