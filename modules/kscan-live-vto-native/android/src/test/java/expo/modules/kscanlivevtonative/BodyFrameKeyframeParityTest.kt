package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The on-device replay sequence interpolates between `BodyFrame.neutral()`
 * and `BodyFrame.armsSlightlyOut()`, which are Kotlin constants. The JVM
 * conformance goldens interpolate between the `neutral-frontal` and
 * `arms-slightly-out` cases in `goldens/bodyframes.json`.
 *
 * If those two ever drift apart, the device would replay a sequence that was
 * never the one measured, and every conformance number captured off-device
 * would silently stop describing what actually runs. This test makes that
 * drift a build failure instead of an invisible divergence.
 */
class BodyFrameKeyframeParityTest {

  private fun landmarkPairs(frame: BodyFrame): Map<String, Vec2?> = mapOf(
    "headCenter" to frame.headCenter.pointOrNull(),
    "neckCenter" to frame.neckCenter.pointOrNull(),
    "leftShoulder" to frame.leftShoulder.pointOrNull(),
    "rightShoulder" to frame.rightShoulder.pointOrNull(),
    "leftElbow" to frame.leftElbow.pointOrNull(),
    "rightElbow" to frame.rightElbow.pointOrNull(),
    "leftWrist" to frame.leftWrist.pointOrNull(),
    "rightWrist" to frame.rightWrist.pointOrNull(),
    "leftHip" to frame.leftHip.pointOrNull(),
    "rightHip" to frame.rightHip.pointOrNull(),
  )

  private fun assertMatchesGolden(caseId: String, kotlinFrame: BodyFrame) {
    val (cases, _) = GoldenBodyFrames.load()
    val golden = cases.firstOrNull { it.id == caseId }
      ?: throw AssertionError("golden case '$caseId' is missing from goldens/bodyframes.json")
    assertEquals(
      "Kotlin keyframe has drifted from golden case '$caseId'",
      landmarkPairs(golden.frame),
      landmarkPairs(kotlinFrame),
    )
  }

  @Test
  fun neutralKeyframeMatchesTheNeutralFrontalGolden() {
    assertMatchesGolden("neutral-frontal", BodyFrame.neutral(0L))
  }

  @Test
  fun armsOutKeyframeMatchesTheArmsSlightlyOutGolden() {
    assertMatchesGolden("arms-slightly-out", BodyFrame.armsSlightlyOut(0L))
  }

  /**
   * The replay source the device runs must produce the same poses, frame for
   * frame, as an identically-parameterised source built from the goldens.
   */
  @Test
  fun onDeviceReplaySourceMatchesTheGoldenDrivenSource() {
    val (cases, _) = GoldenBodyFrames.load()
    fun golden(name: String) = cases.first { it.id == name }.frame

    val fromKotlin = InterpolatedPoseReplaySource(
      "parity", listOf(BodyFrame.neutral(0L), BodyFrame.armsSlightlyOut(0L), BodyFrame.neutral(0L)), 12,
    )
    val fromGoldens = InterpolatedPoseReplaySource(
      "parity", listOf(golden("neutral-frontal"), golden("arms-slightly-out"), golden("neutral-frontal")), 12,
    )

    assertEquals(fromGoldens.frameCount, fromKotlin.frameCount)
    for (i in 0 until fromKotlin.frameCount) {
      assertEquals(
        "replay frame $i diverges between the on-device and golden-driven sources",
        landmarkPairs(fromGoldens.frameAt(i).frame),
        landmarkPairs(fromKotlin.frameAt(i).frame),
      )
    }
  }
}
