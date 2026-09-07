package expo.modules.kscanlivevtonative

import kotlin.math.atan2
import kotlin.math.hypot

/**
 * Maps a provider-agnostic `RawPoseFrame` (BlazePose/MediaPipe Pose 33-point
 * topology, see `PoseLandmarkIndex`) into the governed `BodyFrame` contract.
 *
 * Zero Android dependencies -- same reasoning as `LiveVtoGeometryPipeline`
 * (amendment D8/D10 applied to perception): this file is pure Kotlin so the
 * mapping logic, the left/right canary, the non-finite guard, and the
 * missing-landmark policy are all runnable in a plain JVM test, independent
 * of whether a real device or emulator can execute the model.
 *
 * ── Coordinate convention (mission section 17) ──────────────────────────
 *
 * `BodyFrame`'s own contract is documented as front-camera-mirrored: "the
 * wearer's own left is at the LOWER u." That describes what a LIVE CAMERA
 * frame is expected to look like once N1-F applies its own mirror
 * transform at the camera-input stage -- it is NOT something this adapter
 * applies. This adapter does a DIRECT, unflipped, 1:1 mapping: MediaPipe's
 * own `left_shoulder` (index 11) becomes `BodyFrame.leftShoulder`, exactly
 * as reported, with no horizontal flip introduced here. Whatever left/right
 * relationship exists in the INPUT frame is exactly what ends up in
 * BodyFrame. "Camera mirroring is not yet part of N1-E... do not
 * pre-apply front-camera mirror assumptions here" (mission section 17) --
 * mirroring belongs to the later camera-input transform layer, not to this
 * adapter.
 *
 * ── Absent vs. non-finite vs. low-confidence (mission section 18) ──────
 *
 * Three distinct input conditions, three distinct outcomes -- carrying
 * forward the lesson N1-ENV-008 already established for BodyFrame geometry
 * and applying it one layer earlier, at the perception boundary itself:
 *
 *   - `present = false` (provider did not report this landmark at all) ->
 *     `Landmark.Absent`. A provider saying "I did not observe this" is
 *     working correctly.
 *   - `present = true` but x/y/confidence is NaN or Infinite -> the WHOLE
 *     FRAME is rejected as `InvalidProviderOutput`, never partially mapped.
 *     A provider that is UP and reporting garbage is broken, not merely
 *     uncertain, and mission section 18 requires this be classified
 *     distinctly from "landmark absent."
 *   - `present = true`, finite, but `confidence < MINIMUM_LANDMARK_CONFIDENCE`
 *     -> treated as `Landmark.Absent` for CRITICAL landmarks (shoulders,
 *     hips). This is a deliberate, documented policy choice, not a
 *     dodge: feeding a low-confidence-but-present coordinate into a rigid
 *     geometric fit is exactly "the renderer treating unreliable geometry
 *     as strong tracking" that mission section 20 warns against. Demoting
 *     it to absent lets the EXISTING, already-hardened geometry pipeline
 *     (N1-ENV-007's missing_hips/missing_shoulders paths) handle it, rather
 *     than inventing a second fail-closed mechanism.
 */
object LiveVtoBodyFrameAdapter {

  /**
   * PROVISIONAL, per mission section 20: no pre-existing governed threshold
   * for perception-provider confidence exists anywhere else in this
   * codebase, so this is a new, explicitly-labelled starting point, not a
   * calibrated value. Applied uniformly to every landmark this adapter
   * reads, critical or not, for consistency. Revisit with real device
   * measurements at N1-E device-testing / N1-F.
   */
  const val MINIMUM_LANDMARK_CONFIDENCE = 0.5f

  sealed class Result {
    data class Mapped(val frame: BodyFrame) : Result()

    /** Provider ran; frame is well-formed; no further action needed from the caller beyond noting the reason. */
    data class NoUsablePose(val reason: String) : Result()

    /** The provider reported NaN/Infinity somewhere. Fail closed -- never map, never guess, never partially render. */
    data class InvalidProviderOutput(val reason: String) : Result()
  }

  fun adapt(raw: RawPoseFrame): Result {
    if (raw.landmarks.size < PoseLandmarkIndex.COUNT) {
      return Result.NoUsablePose("landmark list too short: ${raw.landmarks.size} < ${PoseLandmarkIndex.COUNT}")
    }
    if (!raw.poseConfidence.isFinite()) {
      return Result.InvalidProviderOutput("non-finite poseConfidence: ${raw.poseConfidence}")
    }

    // Non-finite check FIRST, across every reported landmark, before any
    // mapping decision is made -- one bad float anywhere fails the whole
    // frame closed, per mission section 18.
    for ((index, lm) in raw.landmarks.withIndex()) {
      if (!lm.present) continue
      if (!lm.x.isFinite() || !lm.y.isFinite() || !lm.confidence.isFinite()) {
        return Result.InvalidProviderOutput("non-finite landmark at index $index: x=${lm.x} y=${lm.y} confidence=${lm.confidence}")
      }
    }

    fun landmarkAt(index: Int, isCritical: Boolean): Landmark {
      val lm = raw.landmarks[index]
      if (!lm.present) return Landmark.Absent
      if (isCritical && lm.confidence < MINIMUM_LANDMARK_CONFIDENCE) return Landmark.Absent
      return Landmark.Present(Vec2(lm.x, lm.y), lm.confidence)
    }

    val leftShoulder = landmarkAt(PoseLandmarkIndex.LEFT_SHOULDER, isCritical = true)
    val rightShoulder = landmarkAt(PoseLandmarkIndex.RIGHT_SHOULDER, isCritical = true)
    val leftHip = landmarkAt(PoseLandmarkIndex.LEFT_HIP, isCritical = true)
    val rightHip = landmarkAt(PoseLandmarkIndex.RIGHT_HIP, isCritical = true)
    val leftElbow = landmarkAt(PoseLandmarkIndex.LEFT_ELBOW, isCritical = false)
    val rightElbow = landmarkAt(PoseLandmarkIndex.RIGHT_ELBOW, isCritical = false)
    val leftWrist = landmarkAt(PoseLandmarkIndex.LEFT_WRIST, isCritical = false)
    val rightWrist = landmarkAt(PoseLandmarkIndex.RIGHT_WRIST, isCritical = false)
    val nose = landmarkAt(PoseLandmarkIndex.NOSE, isCritical = false)

    if (leftShoulder == Landmark.Absent && rightShoulder == Landmark.Absent &&
      leftHip == Landmark.Absent && rightHip == Landmark.Absent
    ) {
      return Result.NoUsablePose("no critical landmarks usable (all absent or below confidence threshold)")
    }

    // ── Derived proxies (neck/chest/waist/torso center+width+height+rotation) ──
    //
    // Not part of the raw pose topology -- BlazePose has no dedicated
    // neck/chest/waist landmark. These are simple midpoint/distance/angle
    // derivations, following the EXACT same precedent and the EXACT same
    // caveat already recorded for the canned N1-B fixture
    // (`BodyFrame.neutral()`'s own doc comment): the real geometry pipeline
    // (`extractBodyAnchors`) computes its own anchors directly from
    // shoulder/hip/elbow/neck landmarks and does NOT consume these derived
    // fields, so an approximation here is not load-bearing for placement.
    // Only computed when both shoulders (or both hips) are actually
    // present; left null/Absent rather than guessed otherwise.
    val ls = (leftShoulder as? Landmark.Present)?.point
    val rs = (rightShoulder as? Landmark.Present)?.point
    val lh = (leftHip as? Landmark.Present)?.point
    val rh = (rightHip as? Landmark.Present)?.point

    val shoulderMid = if (ls != null && rs != null) Vec2((ls.x + rs.x) / 2f, (ls.y + rs.y) / 2f) else null
    val hipMid = if (lh != null && rh != null) Vec2((lh.x + rh.x) / 2f, (lh.y + rh.y) / 2f) else null
    val shoulderSpan = if (ls != null && rs != null) (rs - ls).length() else null

    val neckCenter = when {
      shoulderMid != null && shoulderSpan != null ->
        Landmark.Present(Vec2(shoulderMid.x, shoulderMid.y - shoulderSpan * 0.12f), minOf(
          (leftShoulder as Landmark.Present).confidence, (rightShoulder as Landmark.Present).confidence,
        ))
      else -> Landmark.Absent
    }
    val chestCenter = when {
      shoulderMid != null && hipMid != null ->
        Landmark.Present(Vec2((shoulderMid.x + hipMid.x) / 2f, shoulderMid.y + (hipMid.y - shoulderMid.y) * 0.3f), 1f)
      else -> Landmark.Absent
    }
    val waistCenter = when {
      hipMid != null -> Landmark.Present(hipMid, 1f)
      else -> Landmark.Absent
    }
    val torsoCenter = when {
      shoulderMid != null && hipMid != null ->
        Landmark.Present(Vec2((shoulderMid.x + hipMid.x) / 2f, (shoulderMid.y + hipMid.y) / 2f), 1f)
      else -> Landmark.Absent
    }
    val torsoWidth = shoulderSpan
    val torsoHeight = if (shoulderMid != null && hipMid != null) hypot((hipMid.x - shoulderMid.x).toDouble(), (hipMid.y - shoulderMid.y).toDouble()).toFloat() else null
    val torsoRotation = if (ls != null && rs != null) atan2((rs.y - ls.y), (rs.x - ls.x)) else null

    val headCenter = when (nose) {
      is Landmark.Present -> nose
      Landmark.Absent -> neckCenter // reasonable proxy only when nose itself is absent; never invents a position when neck is also absent
    }

    val criticalConfidences = listOfNotNull(
      (leftShoulder as? Landmark.Present)?.confidence,
      (rightShoulder as? Landmark.Present)?.confidence,
      (leftHip as? Landmark.Present)?.confidence,
      (rightHip as? Landmark.Present)?.confidence,
    )
    val trackingConfidence = if (criticalConfidences.isNotEmpty()) criticalConfidences.min() else 0f

    val bodyFrame = BodyFrame(
      timestampMs = raw.timestampMs,
      headCenter = headCenter,
      noseOrHeadDirection = nose,
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
      trackingConfidence = trackingConfidence,
    )
    return Result.Mapped(bodyFrame)
  }
}
