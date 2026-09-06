package expo.modules.kscanlivevtonative

import android.graphics.PointF
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
  val leftShoulderPx: PointF,
  val rightShoulderPx: PointF,
  val neckBasePx: PointF,
  val leftHipPx: PointF,
  val rightHipPx: PointF,
  val leftElbowPx: PointF?,
  val rightElbowPx: PointF?,
  val shoulderSpanPx: Float,
  val torsoHeightPx: Float,
)

/**
 * Stage 1: normalized BodyFrame landmarks -> pixel-space anchors. Falls back
 * to a shoulder-derived hip estimate when hips are absent (not exercised by
 * the N1-B canned neutral pose, which has both hips present, but present for
 * negative-control robustness).
 */
fun extractBodyAnchors(frame: BodyFrame, canvasWidth: Float, canvasHeight: Float): BodyAnchors? {
  val leftShoulder = frame.leftShoulder.pointOrNull()?.toCanvasPx(canvasWidth, canvasHeight) ?: return null
  val rightShoulder = frame.rightShoulder.pointOrNull()?.toCanvasPx(canvasWidth, canvasHeight) ?: return null
  val shoulderSpanPx = hypot((rightShoulder.x - leftShoulder.x).toDouble(), (rightShoulder.y - leftShoulder.y).toDouble()).toFloat()

  val leftHip = frame.leftHip.pointOrNull()?.toCanvasPx(canvasWidth, canvasHeight)
    ?: PointF(leftShoulder.x, leftShoulder.y + shoulderSpanPx * 1.1f)
  val rightHip = frame.rightHip.pointOrNull()?.toCanvasPx(canvasWidth, canvasHeight)
    ?: PointF(rightShoulder.x, rightShoulder.y + shoulderSpanPx * 1.1f)

  val shoulderMid = PointF((leftShoulder.x + rightShoulder.x) / 2f, (leftShoulder.y + rightShoulder.y) / 2f)
  val hipMid = PointF((leftHip.x + rightHip.x) / 2f, (leftHip.y + rightHip.y) / 2f)
  val torsoHeightPx = hypot((hipMid.x - shoulderMid.x).toDouble(), (hipMid.y - shoulderMid.y).toDouble()).toFloat()
  val neckBase = frame.neckCenter.pointOrNull()?.toCanvasPx(canvasWidth, canvasHeight)
    ?: PointF(shoulderMid.x, shoulderMid.y - shoulderSpanPx * 0.12f)

  return BodyAnchors(
    leftShoulderPx = leftShoulder,
    rightShoulderPx = rightShoulder,
    neckBasePx = neckBase,
    leftHipPx = leftHip,
    rightHipPx = rightHip,
    leftElbowPx = frame.leftElbow.pointOrNull()?.toCanvasPx(canvasWidth, canvasHeight),
    rightElbowPx = frame.rightElbow.pointOrNull()?.toCanvasPx(canvasWidth, canvasHeight),
    shoulderSpanPx = shoulderSpanPx,
    torsoHeightPx = torsoHeightPx,
  )
}

private fun PointF.minus(o: PointF) = PointF(x - o.x, y - o.y)
private fun PointF.plus(o: PointF) = PointF(x + o.x, y + o.y)
private fun PointF.times(s: Float) = PointF(x * s, y * s)
private fun PointF.length() = hypot(x.toDouble(), y.toDouble()).toFloat()
private fun PointF.normalized(): PointF { val l = length(); return if (l < 1e-6f) PointF(0f, 0f) else PointF(x / l, y / l) }
private fun dot(a: PointF, b: PointF) = a.x * b.x + a.y * b.y

data class ControlPointTargets(val targets: Map<GarmentControlPointId, PointF>, val shoulderMidBody: PointF, val hemMidBody: PointF)

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
  val rightDir = anchors.rightShoulderPx.minus(anchors.leftShoulderPx).let { PointF(it.x / anchors.shoulderSpanPx, it.y / anchors.shoulderSpanPx) }
  val upDir = PointF(rightDir.y, -rightDir.x)

  val jointMid = PointF((anchors.leftShoulderPx.x + anchors.rightShoulderPx.x) / 2f, (anchors.leftShoulderPx.y + anchors.rightShoulderPx.y) / 2f)
  val rise = anchors.shoulderSpanPx * c.SHOULDER_SEAM_RISE
  val shoulderMidBody = jointMid.plus(upDir.times(rise))

  val hipMid = PointF((anchors.leftHipPx.x + anchors.rightHipPx.x) / 2f, (anchors.leftHipPx.y + anchors.rightHipPx.y) / 2f)
  val downFromHip = upDir.times(-1f)
  val hemDrop = anchors.torsoHeightPx * c.HIP_LENGTH_HEM_DROP
  val hemMidBody = hipMid.plus(downFromHip.times(hemDrop))

  val bodyAxisLength = max(1e-3f, hemMidBody.minus(shoulderMidBody).length())
  val downDir = hemMidBody.minus(shoulderMidBody).let { PointF(it.x / bodyAxisLength, it.y / bodyAxisLength) }

  val leftShoulderCp = manifest.controlPoint(GarmentControlPointId.LEFT_SHOULDER)
  val rightShoulderCp = manifest.controlPoint(GarmentControlPointId.RIGHT_SHOULDER)
  val leftHemCp = manifest.controlPoint(GarmentControlPointId.LEFT_HEM)
  val rightHemCp = manifest.controlPoint(GarmentControlPointId.RIGHT_HEM)
  requireNotNull(leftShoulderCp); requireNotNull(rightShoulderCp); requireNotNull(leftHemCp); requireNotNull(rightHemCp)

  // Garment's own normalized coordinates -- deliberately NOT converted to
  // texture-pixel space here: lateralOf/longitudinalOf are pure ratios
  // (garment-unit / garment-unit), so normalized and pixel give the
  // identical result and the reference itself keeps them normalized.
  val vShoulder = (leftShoulderCp.v + rightShoulderCp.v) / 2f
  val vHem = (leftHemCp.v + rightHemCp.v) / 2f
  val vSpan = vHem - vShoulder
  val uSpan = rightShoulderCp.u - leftShoulderCp.u
  require(vSpan > 0f && uSpan > 0f) { "degenerate garment control points: vSpan=$vSpan uSpan=$uSpan" }

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

  fun place(u: Float, v: Float): PointF {
    val t = longitudinalOf(v)
    val lateral = lateralOf(u) * widthAt(t)
    val down = t * axisLength
    return PointF(
      shoulderMidBody.x + downDir.x * down + rightDir.x * lateral,
      shoulderMidBody.y + downDir.y * down + rightDir.y * lateral,
    )
  }

  val targets = mutableMapOf<GarmentControlPointId, PointF>()
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
      PointF(d.x / len, d.y / len)
    } else {
      val f = PointF(-upDir.x + rightDir.x * outward * 0.35f, -upDir.y + rightDir.y * outward * 0.35f)
      val len = f.length()
      PointF(f.x / len, f.y / len)
    }

    val candidate = PointF(dir.y, -dir.x)
    val away = seamTarget.minus(shoulderMidBody)
    val sign = if (dot(candidate, away) >= 0f) 1f else -1f
    val normal = candidate.times(sign)
    val armOffset = anchors.shoulderSpanPx * c.UPPER_ARM_HALF_WIDTH

    targets[sleeveCp.id] = PointF(
      seamTarget.x + dir.x * reach + normal.x * armOffset,
      seamTarget.y + dir.y * reach + normal.y * armOffset,
    )
  }

  return ControlPointTargets(targets, shoulderMidBody, hemMidBody)
}

data class RigidPlacement(val scale: Float, val rotationRadians: Float, val translation: PointF)

/**
 * Stage 3: exact similarity transform (uniform scale + rotation +
 * translation) fit from the two shoulder correspondences alone -- two points
 * determine a similarity uniquely, no least squares, no reflection.
 */
fun fitRigidPlacement(manifest: KsgarmentManifest, targets: ControlPointTargets, textureWidth: Int, textureHeight: Int): RigidPlacement {
  val leftCp = manifest.controlPoint(GarmentControlPointId.LEFT_SHOULDER)!!
  val rightCp = manifest.controlPoint(GarmentControlPointId.RIGHT_SHOULDER)!!
  // Garment-space points converted to real texture-pixel space before any
  // vector combining u and v -- see LiveVtoGarmentAttachment.kt's header.
  val leftPx = PointF(leftCp.u * textureWidth, leftCp.v * textureHeight)
  val rightPx = PointF(rightCp.u * textureWidth, rightCp.v * textureHeight)
  val srcVec = rightPx.minus(leftPx)
  val dstLeft = targets.targets[GarmentControlPointId.LEFT_SHOULDER]!!
  val dstRight = targets.targets[GarmentControlPointId.RIGHT_SHOULDER]!!
  val dstVec = dstRight.minus(dstLeft)

  val scale = dstVec.length() / max(1e-6f, srcVec.length())
  val rotation = atan2(dstVec.y.toDouble(), dstVec.x.toDouble()).toFloat() - atan2(srcVec.y.toDouble(), srcVec.x.toDouble()).toFloat()

  // translation such that srcLeft maps exactly onto dstLeft under (scale, rotation)
  val cosR = cos(rotation.toDouble()).toFloat()
  val sinR = sin(rotation.toDouble()).toFloat()
  val rotatedLeft = PointF(leftPx.x * cosR - leftPx.y * sinR, leftPx.x * sinR + leftPx.y * cosR).times(scale)
  val translation = dstLeft.minus(rotatedLeft)

  return RigidPlacement(scale, rotation, translation)
}

/** Applies a fitted similarity transform to a garment-texture-pixel-space point. */
fun applySimilarity(placement: RigidPlacement, p: PointF): PointF {
  val cosR = cos(placement.rotationRadians.toDouble()).toFloat() * placement.scale
  val sinR = sin(placement.rotationRadians.toDouble()).toFloat() * placement.scale
  return PointF(p.x * cosR - p.y * sinR + placement.translation.x, p.x * sinR + p.y * cosR + placement.translation.y)
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

  fun place(id: GarmentControlPointId): PointF? {
    val cp = manifest.controlPoint(id) ?: return null
    return applySimilarity(placement, PointF(cp.u * textureWidth, cp.v * textureHeight))
  }
  val gLeftShoulder = place(GarmentControlPointId.LEFT_SHOULDER)!!
  val gRightShoulder = place(GarmentControlPointId.RIGHT_SHOULDER)!!
  val gLeftHem = place(GarmentControlPointId.LEFT_HEM)
  val gRightHem = place(GarmentControlPointId.RIGHT_HEM)

  val bodyAxis = anchors.rightShoulderPx.minus(anchors.leftShoulderPx)
  val garmentAxis = gRightShoulder.minus(gLeftShoulder)
  if (dot(bodyAxis, garmentAxis) <= 0f) findings.add("left_right_inversion")

  val garmentShoulderSpanPx = garmentAxis.length()
  val scaleRatio = garmentShoulderSpanPx / anchors.shoulderSpanPx

  val downX = -bodyAxis.y / anchors.shoulderSpanPx
  val downY = bodyAxis.x / anchors.shoulderSpanPx
  val shoulderMidGarment = PointF((gLeftShoulder.x + gRightShoulder.x) / 2f, (gLeftShoulder.y + gRightShoulder.y) / 2f)
  var hemBelowShoulderPx = 0f
  if (gLeftHem != null && gRightHem != null) {
    val hemMidGarment = PointF((gLeftHem.x + gRightHem.x) / 2f, (gLeftHem.y + gRightHem.y) / 2f)
    hemBelowShoulderPx = (hemMidGarment.x - shoulderMidGarment.x) * downX + (hemMidGarment.y - shoulderMidGarment.y) * downY
    if (hemBelowShoulderPx <= 0f) findings.add("upside_down")
  }

  if (scaleRatio < 0.55f || scaleRatio > 1.8f) findings.add("gross_scale_error")

  val necklineTolerancePx = anchors.shoulderSpanPx * 0.55f
  val necklineToNeckBasePx = shoulderMidGarment.minus(anchors.neckBasePx).length()
  if (necklineToNeckBasePx > necklineTolerancePx) findings.add("neckline_outside_upper_torso")

  val torsoCentroid = PointF(
    (anchors.leftShoulderPx.x + anchors.rightShoulderPx.x + anchors.leftHipPx.x + anchors.rightHipPx.x) / 4f,
    (anchors.leftShoulderPx.y + anchors.rightShoulderPx.y + anchors.leftHipPx.y + anchors.rightHipPx.y) / 4f,
  )
  val garmentPoints = listOfNotNull(gLeftShoulder, gRightShoulder, gLeftHem, gRightHem)
  val garmentCentroid = garmentPoints.fold(PointF(0f, 0f)) { acc, p -> acc.plus(p) }.let { PointF(it.x / garmentPoints.size, it.y / garmentPoints.size) }
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
fun buildDeformedMeshVertices(manifest: KsgarmentManifest, targets: Map<GarmentControlPointId, PointF>): FloatArray {
  val mesh = manifest.meshDefinition
  val verts = FloatArray((mesh.width + 1) * (mesh.height + 1) * 2)
  val controlSrc = manifest.controlPoints.mapNotNull { cp -> targets[cp.id]?.let { Pair(PointF(cp.u, cp.v), it) } }
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
