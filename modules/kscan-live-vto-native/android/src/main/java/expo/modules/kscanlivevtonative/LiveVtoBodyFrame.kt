package expo.modules.kscanlivevtonative


import kotlin.math.atan2

/**
 * Native re-declaration of the research BodyFrame contract
 * (kscan-live-vto/packages/live-vto-contract/src/bodyFrame.ts, PR #295 @ 266ab1a).
 *
 * BodyFrame is deliberately NOT promoted to the app (see
 * docs/vto-live-integration-manifest.md, "Deliberately not promoted") -- it
 * stays native by design. This is a field-for-field port of the TS shape,
 * not an import (that package is a disjoint, unmerged git history and is
 * mechanically forbidden from being imported -- see
 * scripts/check-vto-live-integration-scope.js), following the same
 * re-declaration pattern vto-phase4-pipeline/src/garmentContract.ts already
 * uses for the .ksgarment schema.
 *
 * Coordinates are normalized [0,1], origin top-left, front-camera-mirrored
 * (the wearer's own left is at the LOWER u) -- same convention as
 * GarmentControlPoint's (u,v). N1-B has no real camera/perception yet, so
 * every BodyFrame at this gate is canned (see NEUTRAL_BODY_FRAME below).
 */
sealed class Landmark {
  data class Present(val point: Vec2, val confidence: Float) : Landmark()
  object Absent : Landmark()

  val isPresent: Boolean get() = this is Present
}

data class BodyFrame(
  val timestampMs: Long,
  val headCenter: Landmark,
  val noseOrHeadDirection: Landmark,
  val neckCenter: Landmark,
  val leftShoulder: Landmark,
  val rightShoulder: Landmark,
  val leftElbow: Landmark,
  val rightElbow: Landmark,
  val leftWrist: Landmark,
  val rightWrist: Landmark,
  val chestCenter: Landmark,
  val waistCenter: Landmark,
  val leftHip: Landmark,
  val rightHip: Landmark,
  val torsoCenter: Landmark,
  val torsoWidth: Float?,
  val torsoHeight: Float?,
  val torsoRotation: Float?,
  val trackingConfidence: Float,
) {
  companion object {
    private fun present(u: Float, v: Float, confidence: Float = 1f) =
      Landmark.Present(Vec2(u, v), confidence)

    /**
     * Canned test pose. Values match the fixture generator's own base pose
     * (kscan-live-vto/packages/evaluation/src/syntheticFixtures.ts
     * generateCenteredStandingSequence's `base`, read via `git show` against
     * the research PR -- not imported, re-typed here same as everything
     * else in this file). A centered, front-facing, neutral standing pose.
     *
     * chestCenter/waistCenter/torsoCenter/torsoWidth/torsoHeight/
     * torsoRotation are DERIVED here (simple midpoint/distance/angle math),
     * not part of the research canned example -- the real deformation
     * pipeline (GarmentAttachment) computes its own anchors directly from
     * the shoulder/hip landmarks and does not consume these derived fields,
     * so approximating them is not load-bearing for N1-B's geometry.
     */
    fun neutral(timestampMs: Long = System.currentTimeMillis()): BodyFrame {
      val headCenter = present(0.5f, 0.15f)
      val neckCenter = present(0.5f, 0.22f)
      val leftShoulder = present(0.38f, 0.28f)
      val rightShoulder = present(0.62f, 0.28f)
      val leftElbow = present(0.32f, 0.45f)
      val rightElbow = present(0.68f, 0.45f)
      val leftWrist = present(0.3f, 0.6f)
      val rightWrist = present(0.7f, 0.6f)
      val leftHip = present(0.4f, 0.6f)
      val rightHip = present(0.6f, 0.6f)

      val shoulderMidX = (0.38f + 0.62f) / 2f
      val shoulderMidY = (0.28f + 0.28f) / 2f
      val hipMidX = (0.4f + 0.6f) / 2f
      val hipMidY = (0.6f + 0.6f) / 2f
      val torsoCenter = present((shoulderMidX + hipMidX) / 2f, (shoulderMidY + hipMidY) / 2f)
      val chestCenter = present(shoulderMidX, (shoulderMidY + hipMidY) / 2f * 0.5f + shoulderMidY * 0.5f)
      val waistCenter = present(hipMidX, hipMidY)
      val torsoWidth = 0.62f - 0.38f
      val torsoHeight = kotlin.math.sqrt(
        (hipMidX - shoulderMidX) * (hipMidX - shoulderMidX) + (hipMidY - shoulderMidY) * (hipMidY - shoulderMidY)
      )
      val torsoRotation = atan2(0.28f - 0.28f, 0.62f - 0.38f)

      return BodyFrame(
        timestampMs = timestampMs,
        headCenter = headCenter,
        noseOrHeadDirection = Landmark.Absent,
        neckCenter = neckCenter,
        leftShoulder = leftShoulder,
        rightShoulder = rightShoulder,
        leftElbow = leftElbow,
        rightElbow = rightElbow,
        leftWrist = leftWrist,
        rightWrist = rightWrist,
        chestCenter = chestCenter,
        waistCenter = waistCenter,
        leftHip = leftHip,
        rightHip = rightHip,
        torsoCenter = torsoCenter,
        torsoWidth = torsoWidth,
        torsoHeight = torsoHeight,
        torsoRotation = torsoRotation,
        trackingConfidence = 1f,
      )
    }

    /**
     * The `arms-slightly-out` golden pose, re-declared here so the on-device
     * replay sequence and the JVM conformance goldens interpolate between
     * the SAME two keyframes. Kept in sync by
     * BodyFrameKeyframeParityTest -- if the golden file changes and this
     * does not, the build fails rather than the device quietly replaying a
     * different sequence than the one that was measured.
     */
    fun armsSlightlyOut(timestampMs: Long = System.currentTimeMillis()): BodyFrame =
      neutral(timestampMs).copy(
        leftElbow = present(0.26f, 0.44f),
        rightElbow = present(0.74f, 0.44f),
        leftWrist = present(0.22f, 0.58f),
        rightWrist = present(0.78f, 0.58f),
      )
  }
}

fun Landmark.pointOrNull(): Vec2? = (this as? Landmark.Present)?.point

/** Normalized [0,1] BodyFrame coordinates -> a pixel-space render canvas. */
fun Vec2.toCanvasPx(canvasWidth: Float, canvasHeight: Float): Vec2 =
  Vec2(x * canvasWidth, y * canvasHeight)
