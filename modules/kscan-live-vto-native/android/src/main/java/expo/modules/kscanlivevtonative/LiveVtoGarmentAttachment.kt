package expo.modules.kscanlivevtonative


import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Port of the P3-A static reference renderer's control-point/rigid-placement
 * geometry (kscan-live-vto/packages/static-renderer/src/attachment.ts,
 * PR #295 @ 266ab1a, read via `git show` -- disjoint history, not imported,
 * see LiveVtoBodyFrame.kt's header). Constants and stage order match that
 * file exactly; this is N1-B/N1-C's oracle-conformance target.
 *
 * N1-B scope: stages 1-4 (anchors, control-point targets, rigid placement,
 * rigid gate) are a faithful port. Stage 5 (mesh deformation) is a
 * deliberately SIMPLIFIED inverse-distance-weighted interpolation across the
 * mesh grid from the computed control-point targets -- NOT the reference's
 * affine-MLS warp (that requires porting @kscan-live-vto/asset-pipeline's
 * deformVertex, which is N1-C's "native deformation + cross-runtime
 * conformance" gate, not N1-B's "first render" gate). Labeled honestly in
 * the N1-B evidence rather than claimed as full parity.
 */
object GarmentAttachmentConstants {
  const val SHOULDER_SEAM_OUTSET = 0.08f
  const val SHOULDER_SEAM_RISE = 0.09f
  const val TORSO_WIDTH_HOLD_T = 0.55f
  const val MAX_LONGITUDINAL_ASPECT_DEVIATION = 0.15f
  const val UPPER_ARM_HALF_WIDTH = 0.11f
  const val HIP_LENGTH_HEM_DROP = 0.28f
}

data class BodyAnchors(
  val leftShoulderPx: Vec2,
  val rightShoulderPx: Vec2,
  val neckBasePx: Vec2,
  val leftHipPx: Vec2,
  val rightHipPx: Vec2,
  val leftElbowPx: Vec2?,
  val rightElbowPx: Vec2?,
  val shoulderSpanPx: Float,
  val torsoHeightPx: Float,
)

/** Result of stage 1. Mirrors the P3-A reference's own discriminated
 *  `{ok:true,anchors} | {ok:false,reason}` return -- see AnchorFailure in
 *  attachment.ts. Kotlin cannot return that shape, so it is a sealed class. */
/** The landmarks attachment geometry actually consumes -- the ones whose
 *  non-finiteness has to be a distinct, reportable failure. */
private val LIVE_VTO_REQUIRED_LANDMARKS: List<(BodyFrame) -> Landmark> = listOf(
  { it.leftShoulder }, { it.rightShoulder }, { it.leftHip }, { it.rightHip },
  { it.neckCenter }, { it.leftElbow }, { it.rightElbow },
)

sealed class AnchorResult {
  data class Success(val anchors: BodyAnchors) : AnchorResult()
  data class Failure(val reason: String) : AnchorResult()
}

/**
 * Stage 1: normalized BodyFrame landmarks -> pixel-space anchors.
 *
 * FAILS CLOSED on absent hips, exactly as the reference does
 * (`missing_hips`). An earlier native pass substituted a shoulder-derived
 * hip estimate here; that is a real cross-runtime divergence, not a
 * robustness improvement -- it makes the native runtime silently render a
 * garment onto a body whose lower half was never observed, where the
 * reference refuses. See N1-ENV-007.
 */
fun extractBodyAnchors(frame: BodyFrame, canvasWidth: Float, canvasHeight: Float): AnchorResult {
  // ABSENT and PRESENT-BUT-GARBAGE are deliberately NOT collapsed into one
  // reason. A provider that reports a landmark as unobserved is working
  // correctly; a provider that reports NaN for it is broken, and at N1-E
  // that difference is the difference between "occluded, wait" and
  // "this perception provider is faulty, stop". Folding the second into
  // `missing_*` would erase the only signal that says so.
  val nonFinite = LIVE_VTO_REQUIRED_LANDMARKS.any { get ->
    (get(frame) as? Landmark.Present)?.point?.isFinite == false
  }
  if (nonFinite) return AnchorResult.Failure(LiveVtoGeometryPipeline.Refusal.NON_FINITE_LANDMARK)

  fun px(l: Landmark): Vec2? = l.pointOrNull()?.takeIf { it.isFinite }?.toCanvasPx(canvasWidth, canvasHeight)

  val leftShoulder = px(frame.leftShoulder) ?: return AnchorResult.Failure(LiveVtoGeometryPipeline.Refusal.MISSING_SHOULDERS)
  val rightShoulder = px(frame.rightShoulder) ?: return AnchorResult.Failure(LiveVtoGeometryPipeline.Refusal.MISSING_SHOULDERS)
  val leftHip = px(frame.leftHip) ?: return AnchorResult.Failure(LiveVtoGeometryPipeline.Refusal.MISSING_HIPS)
  val rightHip = px(frame.rightHip) ?: return AnchorResult.Failure(LiveVtoGeometryPipeline.Refusal.MISSING_HIPS)

  val shoulderSpanPx = (rightShoulder - leftShoulder).length()
  if (!shoulderSpanPx.isFinite() || shoulderSpanPx < 1f) {
    return AnchorResult.Failure(LiveVtoGeometryPipeline.Refusal.DEGENERATE_SHOULDER_SPAN)
  }

  val shoulderMid = Vec2((leftShoulder.x + rightShoulder.x) / 2f, (leftShoulder.y + rightShoulder.y) / 2f)
  val hipMid = Vec2((leftHip.x + rightHip.x) / 2f, (leftHip.y + rightHip.y) / 2f)
  val torsoHeightPx = (hipMid - shoulderMid).length()
  val neckBase = px(frame.neckCenter) ?: Vec2(shoulderMid.x, shoulderMid.y - shoulderSpanPx * 0.12f)

  return AnchorResult.Success(
    BodyAnchors(
      leftShoulderPx = leftShoulder,
      rightShoulderPx = rightShoulder,
      neckBasePx = neckBase,
      leftHipPx = leftHip,
      rightHipPx = rightHip,
      leftElbowPx = px(frame.leftElbow),
      rightElbowPx = px(frame.rightElbow),
      shoulderSpanPx = shoulderSpanPx,
      torsoHeightPx = torsoHeightPx,
    )
  )
}

data class ControlPointTargets(val targets: Map<GarmentControlPointId, Vec2>, val shoulderMidBody: Vec2, val hemMidBody: Vec2)

/**
 * Stage 2: the garment-local frame. Every control point is placed by its own
 * garment-relative longitudinal fraction (from the manifest's OWN authored
 * texture-space v-coordinates) reapplied along the body-space shoulder->hem
 * axis, with a width profile that holds full seam width until
 * TORSO_WIDTH_HOLD_T and only tapers below it. Sleeves are the one family
 * that does not follow the torso frame: they rotate to the elbow direction
 * but never stretch.
 */
fun computeControlPointTargets(anchors: BodyAnchors, manifest: KsgarmentManifest, textureWidth: Int, textureHeight: Int): ControlPointTargets {
  val c = GarmentAttachmentConstants

  // Unit vector along the shoulder line (wearer's left -> right), so a
  // tilted body carries the garment with it. This -- not a perpendicular
  // derived from the shoulder->hem axis -- is the lateral axis; see N1-ENV-006.
  val rightDir = anchors.rightShoulderPx.minus(anchors.leftShoulderPx).let { Vec2(it.x / anchors.shoulderSpanPx, it.y / anchors.shoulderSpanPx) }
  val upDir = Vec2(rightDir.y, -rightDir.x)

  val jointMid = Vec2((anchors.leftShoulderPx.x + anchors.rightShoulderPx.x) / 2f, (anchors.leftShoulderPx.y + anchors.rightShoulderPx.y) / 2f)
  val rise = anchors.shoulderSpanPx * c.SHOULDER_SEAM_RISE
  val shoulderMidBody = jointMid.plus(upDir.times(rise))

  val hipMid = Vec2((anchors.leftHipPx.x + anchors.rightHipPx.x) / 2f, (anchors.leftHipPx.y + anchors.rightHipPx.y) / 2f)
  val downFromHip = upDir.times(-1f)
  val hemDrop = anchors.torsoHeightPx * c.HIP_LENGTH_HEM_DROP
  val hemMidBody = hipMid.plus(downFromHip.times(hemDrop))

  val bodyAxisLength = hemMidBody.minus(shoulderMidBody).length()
  if (!bodyAxisLength.isFinite() || bodyAxisLength < 1f) {
    throw LiveVtoGeometryRefusal(LiveVtoGeometryPipeline.Refusal.DEGENERATE_BODY_AXIS)
  }
  val downDir = hemMidBody.minus(shoulderMidBody).let { Vec2(it.x / bodyAxisLength, it.y / bodyAxisLength) }

  val leftShoulderCp = manifest.controlPoint(GarmentControlPointId.LEFT_SHOULDER)
  val rightShoulderCp = manifest.controlPoint(GarmentControlPointId.RIGHT_SHOULDER)
  val leftHemCp = manifest.controlPoint(GarmentControlPointId.LEFT_HEM)
  val rightHemCp = manifest.controlPoint(GarmentControlPointId.RIGHT_HEM)
  if (leftShoulderCp == null || rightShoulderCp == null || leftHemCp == null || rightHemCp == null) {
    throw LiveVtoGeometryRefusal(LiveVtoGeometryPipeline.Refusal.MISSING_GARMENT_CONTROL_POINTS)
  }

  // Garment's own normalized coordinates -- deliberately NOT converted to
  // texture-pixel space here: lateralOf/longitudinalOf are pure ratios
  // (garment-unit / garment-unit), so normalized and pixel give the
  // identical result and the reference itself keeps them normalized.
  val vShoulder = (leftShoulderCp.v + rightShoulderCp.v) / 2f
  val vHem = (leftHemCp.v + rightHemCp.v) / 2f
  val vSpan = vHem - vShoulder
  val uSpan = rightShoulderCp.u - leftShoulderCp.u
  if (!(vSpan > 0f) || !(uSpan > 0f)) throw LiveVtoGeometryRefusal(LiveVtoGeometryPipeline.Refusal.DEGENERATE_GARMENT_SPAN)

  fun longitudinalOf(v: Float) = (v - vShoulder) / vSpan
  fun lateralOf(u: Float) = (u - 0.5f) / uSpan

  val seamSpanTarget = anchors.shoulderSpanPx * (1f + 2f * c.SHOULDER_SEAM_OUTSET)

  // Longitudinal scale, bounded against the lateral scale so no body can
  // stretch or squash chest content without limit -- MAX_LONGITUDINAL_ASPECT_DEVIATION.
  val textureSeamSpanPx = uSpan * textureWidth
  val textureLengthPx = vSpan * textureHeight
  val lateralScaleForLength = seamSpanTarget / textureSeamSpanPx
  val fittedLongitudinalScale = bodyAxisLength / textureLengthPx
  val maxRatio = 1f + c.MAX_LONGITUDINAL_ASPECT_DEVIATION
  val boundedLongitudinalScale = fittedLongitudinalScale.coerceIn(lateralScaleForLength / maxRatio, lateralScaleForLength * maxRatio)
  val axisLength = boundedLongitudinalScale * textureLengthPx

  // The hem's width comes from the BODY's actual hip width (not the
  // garment's own texture-space hem/shoulder ratio) -- a hip-hugging tee
  // sizes its hem to the hips it is actually worn on.
  val hipHalfWidth = anchors.rightHipPx.minus(anchors.leftHipPx).length() / 2f
  val hemHalfWidthIntended = hipHalfWidth + anchors.shoulderSpanPx * 0.04f
  val hemLateralUnits = abs(lateralOf(leftHemCp.u))
  val widthAtHem = if (hemLateralUnits > 0f) hemHalfWidthIntended / hemLateralUnits else seamSpanTarget

  fun widthAt(t: Float): Float {
    if (t <= c.TORSO_WIDTH_HOLD_T) return seamSpanTarget
    val k = min(1f, (t - c.TORSO_WIDTH_HOLD_T) / (1f - c.TORSO_WIDTH_HOLD_T))
    return seamSpanTarget + (widthAtHem - seamSpanTarget) * k
  }

  fun place(u: Float, v: Float): Vec2 {
    val t = longitudinalOf(v)
    val lateral = lateralOf(u) * widthAt(t)
    val down = t * axisLength
    return Vec2(
      shoulderMidBody.x + downDir.x * down + rightDir.x * lateral,
      shoulderMidBody.y + downDir.y * down + rightDir.y * lateral,
    )
  }

  val targets = mutableMapOf<GarmentControlPointId, Vec2>()
  for (cp in manifest.controlPoints) {
    if (cp.id == GarmentControlPointId.LEFT_SLEEVE || cp.id == GarmentControlPointId.RIGHT_SLEEVE) continue
    targets[cp.id] = place(cp.u, cp.v)
  }

  // Sleeves articulate: placed along the actual upper-arm direction, never
  // stretched (own authored length, scaled by lateralScaleForLength), offset
  // outboard by the arm's half-width -- of the two perpendiculars, the one
  // pointing away from the body's midline (shoulderMidBody).
  for (side in listOf(true, false)) {
    val seamCp = if (side) leftShoulderCp else rightShoulderCp
    val seamTarget = targets[if (side) GarmentControlPointId.LEFT_SHOULDER else GarmentControlPointId.RIGHT_SHOULDER] ?: continue
    val joint = if (side) anchors.leftShoulderPx else anchors.rightShoulderPx
    val elbow = if (side) anchors.leftElbowPx else anchors.rightElbowPx
    val sleeveCp = manifest.controlPoint(if (side) GarmentControlPointId.LEFT_SLEEVE else GarmentControlPointId.RIGHT_SLEEVE) ?: continue
    val outward = if (side) -1f else 1f

    val sleeveLengthTexture = hypot(((sleeveCp.u - seamCp.u) * textureWidth).toDouble(), ((sleeveCp.v - seamCp.v) * textureHeight).toDouble()).toFloat()
    val reach = sleeveLengthTexture * lateralScaleForLength

    val dir = if (elbow != null) {
      val d = elbow.minus(joint)
      val len = d.length()
      if (len < 1f) continue
      Vec2(d.x / len, d.y / len)
    } else {
      val f = Vec2(-upDir.x + rightDir.x * outward * 0.35f, -upDir.y + rightDir.y * outward * 0.35f)
      val len = f.length()
      Vec2(f.x / len, f.y / len)
    }

    val candidate = Vec2(dir.y, -dir.x)
    val away = seamTarget.minus(shoulderMidBody)
    val sign = if (dot(candidate, away) >= 0f) 1f else -1f
    val normal = candidate.times(sign)
    val armOffset = anchors.shoulderSpanPx * c.UPPER_ARM_HALF_WIDTH

    targets[sleeveCp.id] = Vec2(
      seamTarget.x + dir.x * reach + normal.x * armOffset,
      seamTarget.y + dir.y * reach + normal.y * armOffset,
    )
  }

  return ControlPointTargets(targets, shoulderMidBody, hemMidBody)
}

data class RigidPlacement(val scale: Float, val rotationRadians: Float, val translation: Vec2)

/**
 * Stage 3: exact similarity transform (uniform scale + rotation +
 * translation) fit from the two shoulder correspondences alone -- two points
 * determine a similarity uniquely, no least squares, no reflection.
 */
fun fitRigidPlacement(manifest: KsgarmentManifest, targets: ControlPointTargets, textureWidth: Int, textureHeight: Int): RigidPlacement? {
  val leftCp = manifest.controlPoint(GarmentControlPointId.LEFT_SHOULDER) ?: return null
  val rightCp = manifest.controlPoint(GarmentControlPointId.RIGHT_SHOULDER) ?: return null
  // Garment-space points converted to real texture-pixel space before any
  // vector combining u and v -- see LiveVtoGarmentAttachment.kt's header.
  val leftPx = Vec2(leftCp.u * textureWidth, leftCp.v * textureHeight)
  val rightPx = Vec2(rightCp.u * textureWidth, rightCp.v * textureHeight)
  val srcVec = rightPx.minus(leftPx)
  val dstLeft = targets.targets[GarmentControlPointId.LEFT_SHOULDER] ?: return null
  val dstRight = targets.targets[GarmentControlPointId.RIGHT_SHOULDER] ?: return null
  val dstVec = dstRight.minus(dstLeft)

  val scale = dstVec.length() / max(1e-6f, srcVec.length())
  val rotation = atan2(dstVec.y.toDouble(), dstVec.x.toDouble()).toFloat() - atan2(srcVec.y.toDouble(), srcVec.x.toDouble()).toFloat()

  // translation such that srcLeft maps exactly onto dstLeft under (scale, rotation)
  val cosR = cos(rotation.toDouble()).toFloat()
  val sinR = sin(rotation.toDouble()).toFloat()
  val rotatedLeft = Vec2(leftPx.x * cosR - leftPx.y * sinR, leftPx.x * sinR + leftPx.y * cosR).times(scale)
  val translation = dstLeft.minus(rotatedLeft)

  return RigidPlacement(scale, rotation, translation)
}

/** Applies a fitted similarity transform to a garment-texture-pixel-space point. */
fun applySimilarity(placement: RigidPlacement, p: Vec2): Vec2 {
  val cosR = cos(placement.rotationRadians.toDouble()).toFloat() * placement.scale
  val sinR = sin(placement.rotationRadians.toDouble()).toFloat() * placement.scale
  return Vec2(p.x * cosR - p.y * sinR + placement.translation.x, p.x * sinR + p.y * cosR + placement.translation.y)
}

data class RigidGateResult(val passed: Boolean, val findings: List<String>)

/**
 * Stage 4: gross-error detector, not a quality judgement -- deformation
 * cannot repair incorrect semantic anchoring. Faithful port of the
 * reference's five checks, including its choice to gate against the RIGID
 * placement of the garment's own control points (via applySimilarity), not
 * against the deformed targets.
 */
fun evaluateRigidGate(anchors: BodyAnchors, manifest: KsgarmentManifest, placement: RigidPlacement, textureWidth: Int, textureHeight: Int): RigidGateResult {
  val findings = mutableListOf<String>()

  fun place(id: GarmentControlPointId): Vec2? {
    val cp = manifest.controlPoint(id) ?: return null
    return applySimilarity(placement, Vec2(cp.u * textureWidth, cp.v * textureHeight))
  }
  val gLeftShoulder = place(GarmentControlPointId.LEFT_SHOULDER)
    ?: return RigidGateResult(false, listOf(LiveVtoGeometryPipeline.Refusal.MISSING_GARMENT_CONTROL_POINTS))
  val gRightShoulder = place(GarmentControlPointId.RIGHT_SHOULDER)
    ?: return RigidGateResult(false, listOf(LiveVtoGeometryPipeline.Refusal.MISSING_GARMENT_CONTROL_POINTS))
  val gLeftHem = place(GarmentControlPointId.LEFT_HEM)
  val gRightHem = place(GarmentControlPointId.RIGHT_HEM)

  val bodyAxis = anchors.rightShoulderPx.minus(anchors.leftShoulderPx)
  val garmentAxis = gRightShoulder.minus(gLeftShoulder)
  if (dot(bodyAxis, garmentAxis) <= 0f) findings.add("left_right_inversion")

  val garmentShoulderSpanPx = garmentAxis.length()
  val scaleRatio = garmentShoulderSpanPx / anchors.shoulderSpanPx

  val downX = -bodyAxis.y / anchors.shoulderSpanPx
  val downY = bodyAxis.x / anchors.shoulderSpanPx
  val shoulderMidGarment = Vec2((gLeftShoulder.x + gRightShoulder.x) / 2f, (gLeftShoulder.y + gRightShoulder.y) / 2f)
  var hemBelowShoulderPx = 0f
  if (gLeftHem != null && gRightHem != null) {
    val hemMidGarment = Vec2((gLeftHem.x + gRightHem.x) / 2f, (gLeftHem.y + gRightHem.y) / 2f)
    hemBelowShoulderPx = (hemMidGarment.x - shoulderMidGarment.x) * downX + (hemMidGarment.y - shoulderMidGarment.y) * downY
    if (hemBelowShoulderPx <= 0f) findings.add("upside_down")
  }

  if (scaleRatio < 0.55f || scaleRatio > 1.8f) findings.add("gross_scale_error")

  val necklineTolerancePx = anchors.shoulderSpanPx * 0.55f
  val necklineToNeckBasePx = shoulderMidGarment.minus(anchors.neckBasePx).length()
  if (necklineToNeckBasePx > necklineTolerancePx) findings.add("neckline_outside_upper_torso")

  val torsoCentroid = Vec2(
    (anchors.leftShoulderPx.x + anchors.rightShoulderPx.x + anchors.leftHipPx.x + anchors.rightHipPx.x) / 4f,
    (anchors.leftShoulderPx.y + anchors.rightShoulderPx.y + anchors.leftHipPx.y + anchors.rightHipPx.y) / 4f,
  )
  val garmentPoints = listOfNotNull(gLeftShoulder, gRightShoulder, gLeftHem, gRightHem)
  val garmentCentroid = garmentPoints.fold(Vec2(0f, 0f)) { acc, p -> acc.plus(p) }.let { Vec2(it.x / garmentPoints.size, it.y / garmentPoints.size) }
  val torsoDiagonalPx = hypot(anchors.shoulderSpanPx.toDouble(), anchors.torsoHeightPx.toDouble()).toFloat()
  if (garmentCentroid.minus(torsoCentroid).length() > torsoDiagonalPx * 0.5f) findings.add("garment_largely_outside_torso")

  return RigidGateResult(findings.isEmpty(), findings)
}

/**
 * N1-B simplified stage 5: inverse-distance-weighted interpolation of every
 * mesh-grid vertex's texture-space position from the (up to 11) computed
 * control-point correspondences. Not the reference's affine-MLS warp --
 * documented as a known simplification, not claimed as N1-C's deformation
 * parity.
 */
fun buildDeformedMeshVertices(manifest: KsgarmentManifest, targets: Map<GarmentControlPointId, Vec2>): FloatArray {
  val mesh = manifest.meshDefinition
  val verts = FloatArray((mesh.width + 1) * (mesh.height + 1) * 2)
  val controlSrc = manifest.controlPoints.mapNotNull { cp -> targets[cp.id]?.let { Pair(Vec2(cp.u, cp.v), it) } }
  var idx = 0
  for (row in 0..mesh.height) {
    val v = row.toFloat() / mesh.height
    for (col in 0..mesh.width) {
      val u = col.toFloat() / mesh.width
      var sumW = 0f; var sx = 0f; var sy = 0f
      for ((src, dst) in controlSrc) {
        val d = hypot((u - src.x).toDouble(), (v - src.y).toDouble()).toFloat()
        val w = 1f / (d * d + 1e-4f)
        sumW += w; sx += dst.x * w; sy += dst.y * w
      }
      verts[idx++] = if (sumW > 0f) sx / sumW else 0f
      verts[idx++] = if (sumW > 0f) sy / sumW else 0f
    }
  }
  return verts
}
