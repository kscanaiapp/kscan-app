package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val CANVAS_W = 720f
private const val CANVAS_H = 960f

/**
 * N1-E: `LiveVtoBodyFrameAdapter` tested against hand-built `RawPoseFrame`
 * fixtures shaped exactly like the real MediaPipe Pose 33-point topology
 * (verified against the bundled 1.0.0 AAR's own `NormalizedLandmark` type,
 * not assumed). These are NOT a substitute for real on-device inference --
 * mission section 14 is explicit that hardcoded landmarks do not count as
 * `REAL_MODEL EXECUTED: YES`. What they DO prove, independent of whether
 * any device or emulator can run the real model, is that the ADAPTER'S OWN
 * mapping logic is correct: absent vs. non-finite vs. low-confidence
 * handling, and -- given this lane's history of exactly this defect class
 * -- that the adapter introduces no left/right swap of its own.
 */
class BodyFrameAdapterTest {

  private fun blankLandmarks(): MutableList<RawPoseLandmark> =
    MutableList(PoseLandmarkIndex.COUNT) { RawPoseLandmark(0f, 0f, 0f, present = false) }

  private fun present(x: Float, y: Float, confidence: Float = 0.9f) = RawPoseLandmark(x, y, confidence, present = true)

  private fun neutralFrame(): RawPoseFrame {
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.NOSE] = present(0.5f, 0.15f)
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(0.38f, 0.28f)
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = present(0.62f, 0.28f)
    lm[PoseLandmarkIndex.LEFT_ELBOW] = present(0.32f, 0.45f)
    lm[PoseLandmarkIndex.RIGHT_ELBOW] = present(0.68f, 0.45f)
    lm[PoseLandmarkIndex.LEFT_WRIST] = present(0.30f, 0.60f)
    lm[PoseLandmarkIndex.RIGHT_WRIST] = present(0.70f, 0.60f)
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.40f, 0.60f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.60f, 0.60f)
    return RawPoseFrame(timestampMs = 1000L, landmarks = lm, poseConfidence = 0.95f)
  }

  // ── Basic mapping ────────────────────────────────────────────────────────

  @Test
  fun aWellFormedFrameMapsEveryGovernedFieldItCanAndNoneItCannot() {
    val result = LiveVtoBodyFrameAdapter.adapt(neutralFrame())
    assertTrue(result is LiveVtoBodyFrameAdapter.Result.Mapped)
    val frame = (result as LiveVtoBodyFrameAdapter.Result.Mapped).frame

    assertEquals(1000L, frame.timestampMs)
    assertTrue(frame.leftShoulder is Landmark.Present)
    assertTrue(frame.rightShoulder is Landmark.Present)
    assertTrue(frame.leftHip is Landmark.Present)
    assertTrue(frame.rightHip is Landmark.Present)
    assertTrue("no neck landmark in BlazePose -- must be a derived proxy, not absent, when both shoulders are present",
      frame.neckCenter is Landmark.Present)
    assertTrue(frame.torsoWidth != null && frame.torsoWidth!! > 0f)
    assertTrue(frame.torsoHeight != null && frame.torsoHeight!! > 0f)

    // Direct passthrough of the raw coordinate, not a recomputation.
    val ls = (frame.leftShoulder as Landmark.Present).point
    assertEquals(0.38f, ls.x, 1e-6f)
    assertEquals(0.28f, ls.y, 1e-6f)
  }

  @Test
  fun theEntireGeometryPipelineAcceptsAnAdaptedFrame() {
    // Proves the adapter's output is actually consumable by the existing,
    // already-conformance-tested geometry pipeline -- not just structurally
    // valid in isolation.
    val result = LiveVtoBodyFrameAdapter.adapt(neutralFrame())
    val frame = (result as LiveVtoBodyFrameAdapter.Result.Mapped).frame
    val (manifest, dims) = GoldenBodyFrames.fixture("n1b-fixture")
    val snapshot = LiveVtoGeometryPipeline.compute(manifest, frame, "adapter-neutral", CANVAS_W, CANVAS_H, dims.first, dims.second)
    assertEquals("adapted frame was refused by geometry: ${snapshot.failure}", null, snapshot.failure)
    assertTrue("adapted frame failed the rigid gate: ${snapshot.gateFindings}", snapshot.gatePassed)
  }

  // ── Left/right canary (mission section 16) ───────────────────────────────

  @Test
  fun theAdapterIntroducesNoLeftRightSwap() {
    val lm = blankLandmarks()
    // Deliberately asymmetric and far from the neutral fixture's values, so
    // this cannot pass by coincidentally matching another test's numbers.
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(0.20f, 0.25f)
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = present(0.75f, 0.30f)
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.25f, 0.65f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.70f, 0.65f)
    val raw = RawPoseFrame(2000L, lm, 0.9f)

    val result = LiveVtoBodyFrameAdapter.adapt(raw) as LiveVtoBodyFrameAdapter.Result.Mapped
    val f = result.frame

    val ls = (f.leftShoulder as Landmark.Present).point
    val rs = (f.rightShoulder as Landmark.Present).point
    val lh = (f.leftHip as Landmark.Present).point
    val rh = (f.rightHip as Landmark.Present).point

    assertEquals("provider left_shoulder must become BodyFrame.leftShoulder verbatim", 0.20f, ls.x, 1e-6f)
    assertEquals("provider right_shoulder must become BodyFrame.rightShoulder verbatim", 0.75f, rs.x, 1e-6f)
    assertEquals(0.25f, lh.x, 1e-6f)
    assertEquals(0.70f, rh.x, 1e-6f)
    assertTrue("left must stay left", ls.x < rs.x)
    assertTrue("left hip must stay left", lh.x < rh.x)
  }

  @Test
  fun theCanaryFrameSurvivesGeometryWithoutAMirrorFinding() {
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(0.30f, 0.28f)
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = present(0.70f, 0.28f)
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.35f, 0.60f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.65f, 0.60f)
    lm[PoseLandmarkIndex.LEFT_ELBOW] = present(0.20f, 0.45f)
    lm[PoseLandmarkIndex.RIGHT_ELBOW] = present(0.80f, 0.45f)
    val raw = RawPoseFrame(3000L, lm, 0.9f)

    val frame = (LiveVtoBodyFrameAdapter.adapt(raw) as LiveVtoBodyFrameAdapter.Result.Mapped).frame
    val (manifest, dims) = GoldenBodyFrames.fixture("n1c-asym-fixture")
    val snapshot = LiveVtoGeometryPipeline.compute(manifest, frame, "adapter-canary", CANVAS_W, CANVAS_H, dims.first, dims.second)

    assertEquals(null, snapshot.failure)
    assertFalse("left/right inversion reported for a straight-mapped asymmetric frame",
      snapshot.gateFindings.contains("left_right_inversion"))
    val gLeft = snapshot.controlPoints.getValue("leftShoulder")
    val gRight = snapshot.controlPoints.getValue("rightShoulder")
    assertTrue("garment left must stay left of garment right", gLeft.x < gRight.x)
  }

  // ── Non-finite provider output (mission section 18) ──────────────────────

  @Test
  fun aNaNLandmarkCoordinateIsRejectedAsInvalidProviderOutputNotAsAbsent() {
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(Float.NaN, 0.28f)
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = present(0.62f, 0.28f)
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.40f, 0.60f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.60f, 0.60f)
    val result = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(4000L, lm, 0.9f))
    assertTrue(result is LiveVtoBodyFrameAdapter.Result.InvalidProviderOutput)
  }

  @Test
  fun anInfiniteConfidenceIsRejectedAsInvalidProviderOutput() {
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(0.38f, 0.28f, confidence = Float.POSITIVE_INFINITY)
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = present(0.62f, 0.28f)
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.40f, 0.60f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.60f, 0.60f)
    val result = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(5000L, lm, 0.9f))
    assertTrue(result is LiveVtoBodyFrameAdapter.Result.InvalidProviderOutput)
  }

  @Test
  fun aNonFiniteOverallPoseConfidenceIsRejected() {
    val result = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(6000L, blankLandmarks(), Float.NaN))
    assertTrue(result is LiveVtoBodyFrameAdapter.Result.InvalidProviderOutput)
  }

  // ── Absent / missing landmarks (mission section 19) ──────────────────────

  @Test
  fun anAbsentLandmarkMapsToAbsentNeverToAGuessedZero() {
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(0.38f, 0.28f)
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = present(0.62f, 0.28f)
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.40f, 0.60f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.60f, 0.60f)
    // leftElbow/rightWrist left absent (present = false, the blank default).
    val frame = (LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(7000L, lm, 0.9f)) as LiveVtoBodyFrameAdapter.Result.Mapped).frame
    assertEquals(Landmark.Absent, frame.leftElbow)
    assertEquals(Landmark.Absent, frame.rightWrist)
  }

  @Test
  fun missingBothShouldersButPresentHipsStillProducesNoUsablePoseWhenHipsAlsoBelowThreshold() {
    // Both shoulders absent, hips present but below the confidence floor --
    // every critical landmark ends up Absent, so the frame is refused
    // upstream of geometry rather than handed to it half-formed.
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.40f, 0.60f, confidence = 0.1f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.60f, 0.60f, confidence = 0.1f)
    val result = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(8000L, lm, 0.9f))
    assertTrue(result is LiveVtoBodyFrameAdapter.Result.NoUsablePose)
  }

  @Test
  fun oneCriticalLandmarkPresentIsEnoughToAttemptAMapping() {
    // Not every geometry stage will succeed with only one hip, but the
    // ADAPTER's own job -- deciding whether there is anything worth handing
    // downstream at all -- must not refuse just because the frame is
    // partial. The geometry pipeline's own extractBodyAnchors is what
    // ultimately enforces "need both shoulders and both hips."
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(0.38f, 0.28f)
    val result = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(9000L, lm, 0.9f))
    assertTrue(result is LiveVtoBodyFrameAdapter.Result.Mapped)
  }

  // ── Low confidence (mission section 20) ───────────────────────────────────

  @Test
  fun aCriticalLandmarkBelowTheConfidenceFloorIsDemotedToAbsentNotPresent() {
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(0.38f, 0.28f, confidence = 0.05f) // well under the floor
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = present(0.62f, 0.28f, confidence = 0.95f)
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.40f, 0.60f, confidence = 0.95f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.60f, 0.60f, confidence = 0.95f)
    val frame = (LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(10000L, lm, 0.9f)) as LiveVtoBodyFrameAdapter.Result.Mapped).frame
    assertEquals(
      "a low-confidence critical landmark must not be treated as strong tracking",
      Landmark.Absent,
      frame.leftShoulder,
    )
  }

  @Test
  fun trackingConfidencePropagatesAsTheMinimumOverCriticalLandmarks() {
    val lm = blankLandmarks()
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = present(0.38f, 0.28f, confidence = 0.99f)
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = present(0.62f, 0.28f, confidence = 0.60f)
    lm[PoseLandmarkIndex.LEFT_HIP] = present(0.40f, 0.60f, confidence = 0.99f)
    lm[PoseLandmarkIndex.RIGHT_HIP] = present(0.60f, 0.60f, confidence = 0.99f)
    val frame = (LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(11000L, lm, 0.9f)) as LiveVtoBodyFrameAdapter.Result.Mapped).frame
    assertEquals(0.60f, frame.trackingConfidence, 1e-6f)
  }

  @Test
  fun aFrameWithNoCriticalLandmarksAtAllIsNoUsablePose() {
    val result = LiveVtoBodyFrameAdapter.adapt(RawPoseFrame(12000L, blankLandmarks(), 0.9f))
    assertTrue(result is LiveVtoBodyFrameAdapter.Result.NoUsablePose)
  }
}
