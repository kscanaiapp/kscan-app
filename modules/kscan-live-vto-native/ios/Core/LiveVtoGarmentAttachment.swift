import Foundation

/// Port of the P3-A static reference renderer's control-point/rigid-placement
/// geometry (`kscan-live-vto/packages/static-renderer/src/attachment.ts`,
/// reference SHA `e7c5d72` at the time this iOS port was written -- see
/// `docs/vto-live-bridge-contract.md`), by way of Android's own faithful port
/// in `LiveVtoGarmentAttachment.kt`. Constants and stage order match both
/// exactly; this is the iOS conformance target for the same golden fixtures
/// Android measures against.
public enum GarmentAttachmentConstants {
  public static let shoulderSeamOutset: Float = 0.08
  public static let shoulderSeamRise: Float = 0.09
  public static let torsoWidthHoldT: Float = 0.55
  public static let maxLongitudinalAspectDeviation: Float = 0.15
  public static let upperArmHalfWidth: Float = 0.11
  public static let hipLengthHemDrop: Float = 0.28
}

public struct BodyAnchors: Equatable {
  public let leftShoulderPx: Vec2
  public let rightShoulderPx: Vec2
  public let neckBasePx: Vec2
  public let leftHipPx: Vec2
  public let rightHipPx: Vec2
  public let leftElbowPx: Vec2?
  public let rightElbowPx: Vec2?
  public let shoulderSpanPx: Float
  public let torsoHeightPx: Float
}

/// Result of stage 1. Mirrors the P3-A reference's own discriminated
/// `{ok:true,anchors} | {ok:false,reason}` return.
public enum AnchorResult: Equatable {
  case success(BodyAnchors)
  case failure(reason: String)
}

/// The landmarks attachment geometry actually consumes -- the ones whose
/// non-finiteness has to be a distinct, reportable failure.
private let liveVtoRequiredLandmarks: [(BodyFrame) -> Landmark] = [
  { $0.leftShoulder }, { $0.rightShoulder }, { $0.leftHip }, { $0.rightHip },
  { $0.neckCenter }, { $0.leftElbow }, { $0.rightElbow },
]

/// Stage 1: normalized BodyFrame landmarks -> pixel-space anchors.
///
/// FAILS CLOSED on absent hips, exactly as the reference does
/// (`missingHips`). Substituting a shoulder-derived hip estimate here would
/// be a real cross-runtime divergence, not a robustness improvement -- see
/// Android's N1-ENV-007.
public func extractBodyAnchors(_ frame: BodyFrame, canvasWidth: Float, canvasHeight: Float) -> AnchorResult {
  // ABSENT and PRESENT-BUT-GARBAGE are deliberately NOT collapsed into one
  // reason. A provider that reports a landmark as unobserved is working
  // correctly; a provider that reports NaN for it is broken, and that
  // difference is the difference between "occluded, wait" and "this
  // perception provider is faulty, stop."
  let nonFinite = liveVtoRequiredLandmarks.contains { get in
    if case .present(let point, _) = get(frame) { return !point.isFinite }
    return false
  }
  if nonFinite { return .failure(reason: LiveVtoGeometryPipeline.Refusal.nonFiniteLandmark) }

  func px(_ l: Landmark) -> Vec2? {
    guard let point = l.pointOrNull, point.isFinite else { return nil }
    return toCanvasPx(point, canvasWidth: canvasWidth, canvasHeight: canvasHeight)
  }

  guard let leftShoulder = px(frame.leftShoulder) else { return .failure(reason: LiveVtoGeometryPipeline.Refusal.missingShoulders) }
  guard let rightShoulder = px(frame.rightShoulder) else { return .failure(reason: LiveVtoGeometryPipeline.Refusal.missingShoulders) }
  guard let leftHip = px(frame.leftHip) else { return .failure(reason: LiveVtoGeometryPipeline.Refusal.missingHips) }
  guard let rightHip = px(frame.rightHip) else { return .failure(reason: LiveVtoGeometryPipeline.Refusal.missingHips) }

  let shoulderSpanPx = (rightShoulder - leftShoulder).length()
  if !shoulderSpanPx.isFinite || shoulderSpanPx < 1 {
    return .failure(reason: LiveVtoGeometryPipeline.Refusal.degenerateShoulderSpan)
  }

  let shoulderMid = Vec2((leftShoulder.x + rightShoulder.x) / 2, (leftShoulder.y + rightShoulder.y) / 2)
  let hipMid = Vec2((leftHip.x + rightHip.x) / 2, (leftHip.y + rightHip.y) / 2)
  let torsoHeightPx = (hipMid - shoulderMid).length()
  let neckBase = px(frame.neckCenter) ?? Vec2(shoulderMid.x, shoulderMid.y - shoulderSpanPx * 0.12)

  return .success(BodyAnchors(
    leftShoulderPx: leftShoulder, rightShoulderPx: rightShoulder, neckBasePx: neckBase,
    leftHipPx: leftHip, rightHipPx: rightHip,
    leftElbowPx: px(frame.leftElbow), rightElbowPx: px(frame.rightElbow),
    shoulderSpanPx: shoulderSpanPx, torsoHeightPx: torsoHeightPx))
}

public struct ControlPointTargets {
  public let targets: [GarmentControlPointId: Vec2]
  public let shoulderMidBody: Vec2
  public let hemMidBody: Vec2
}

/// Signal from a geometry stage that it cannot proceed. Never escapes `LiveVtoGeometryPipeline.compute`.
public struct LiveVtoGeometryRefusal: Error {
  public let reason: String
  public init(_ reason: String) { self.reason = reason }
}

/// Stage 2: the garment-local frame. Every control point is placed by its own
/// garment-relative longitudinal fraction (from the manifest's OWN authored
/// texture-space v-coordinates) reapplied along the body-space
/// shoulder->hem axis, with a width profile that holds full seam width until
/// `torsoWidthHoldT` and only tapers below it. Sleeves are the one family
/// that does not follow the torso frame: they rotate to the elbow direction
/// but never stretch.
public func computeControlPointTargets(
  _ anchors: BodyAnchors, manifest: KsgarmentManifest, textureWidth: Int, textureHeight: Int
) throws -> ControlPointTargets {
  let c = GarmentAttachmentConstants.self

  // Unit vector along the shoulder line (wearer's left -> right), so a
  // tilted body carries the garment with it. This -- not a perpendicular
  // derived from the shoulder->hem axis -- is the lateral axis.
  let shoulderDelta = anchors.rightShoulderPx - anchors.leftShoulderPx
  let rightDir = Vec2(shoulderDelta.x / anchors.shoulderSpanPx, shoulderDelta.y / anchors.shoulderSpanPx)
  let upDir = Vec2(rightDir.y, -rightDir.x)

  let jointMid = Vec2(
    (anchors.leftShoulderPx.x + anchors.rightShoulderPx.x) / 2,
    (anchors.leftShoulderPx.y + anchors.rightShoulderPx.y) / 2)
  let rise = anchors.shoulderSpanPx * c.shoulderSeamRise
  let shoulderMidBody = jointMid + upDir * rise

  let hipMid = Vec2((anchors.leftHipPx.x + anchors.rightHipPx.x) / 2, (anchors.leftHipPx.y + anchors.rightHipPx.y) / 2)
  let downFromHip = upDir * -1
  let hemDrop = anchors.torsoHeightPx * c.hipLengthHemDrop
  let hemMidBody = hipMid + downFromHip * hemDrop

  let bodyAxisLength = (hemMidBody - shoulderMidBody).length()
  if !bodyAxisLength.isFinite || bodyAxisLength < 1 {
    throw LiveVtoGeometryRefusal(LiveVtoGeometryPipeline.Refusal.degenerateBodyAxis)
  }
  let bodyAxisDelta = hemMidBody - shoulderMidBody
  let downDir = Vec2(bodyAxisDelta.x / bodyAxisLength, bodyAxisDelta.y / bodyAxisLength)

  guard
    let leftShoulderCp = manifest.controlPoint(.leftShoulder),
    let rightShoulderCp = manifest.controlPoint(.rightShoulder),
    let leftHemCp = manifest.controlPoint(.leftHem),
    let rightHemCp = manifest.controlPoint(.rightHem)
  else {
    throw LiveVtoGeometryRefusal(LiveVtoGeometryPipeline.Refusal.missingGarmentControlPoints)
  }

  // Garment's own normalized coordinates -- deliberately NOT converted to
  // texture-pixel space here: lateralOf/longitudinalOf are pure ratios
  // (garment-unit / garment-unit), so normalized and pixel give the
  // identical result and the reference itself keeps them normalized.
  let vShoulder = (leftShoulderCp.v + rightShoulderCp.v) / 2
  let vHem = (leftHemCp.v + rightHemCp.v) / 2
  let vSpan = vHem - vShoulder
  let uSpan = rightShoulderCp.u - leftShoulderCp.u
  if !(vSpan > 0) || !(uSpan > 0) { throw LiveVtoGeometryRefusal(LiveVtoGeometryPipeline.Refusal.degenerateGarmentSpan) }

  func longitudinalOf(_ v: Float) -> Float { (v - vShoulder) / vSpan }
  func lateralOf(_ u: Float) -> Float { (u - 0.5) / uSpan }

  let seamSpanTarget = anchors.shoulderSpanPx * (1 + 2 * c.shoulderSeamOutset)

  // Longitudinal scale, bounded against the lateral scale so no body can
  // stretch or squash chest content without limit.
  let textureSeamSpanPx = uSpan * Float(textureWidth)
  let textureLengthPx = vSpan * Float(textureHeight)
  let lateralScaleForLength = seamSpanTarget / textureSeamSpanPx
  let fittedLongitudinalScale = bodyAxisLength / textureLengthPx
  let maxRatio = 1 + c.maxLongitudinalAspectDeviation
  let boundedLongitudinalScale = min(max(fittedLongitudinalScale, lateralScaleForLength / maxRatio), lateralScaleForLength * maxRatio)
  let axisLength = boundedLongitudinalScale * textureLengthPx

  // The hem's width comes from the BODY's actual hip width (not the
  // garment's own texture-space hem/shoulder ratio) -- a hip-hugging tee
  // sizes its hem to the hips it is actually worn on.
  let hipHalfWidth = (anchors.rightHipPx - anchors.leftHipPx).length() / 2
  let hemHalfWidthIntended = hipHalfWidth + anchors.shoulderSpanPx * 0.04
  let hemLateralUnits = abs(lateralOf(leftHemCp.u))
  let widthAtHem = hemLateralUnits > 0 ? hemHalfWidthIntended / hemLateralUnits : seamSpanTarget

  func widthAt(_ t: Float) -> Float {
    if t <= c.torsoWidthHoldT { return seamSpanTarget }
    let k = min(1, (t - c.torsoWidthHoldT) / (1 - c.torsoWidthHoldT))
    return seamSpanTarget + (widthAtHem - seamSpanTarget) * k
  }

  func place(_ u: Float, _ v: Float) -> Vec2 {
    let t = longitudinalOf(v)
    let lateral = lateralOf(u) * widthAt(t)
    let down = t * axisLength
    return Vec2(
      shoulderMidBody.x + downDir.x * down + rightDir.x * lateral,
      shoulderMidBody.y + downDir.y * down + rightDir.y * lateral)
  }

  var targets: [GarmentControlPointId: Vec2] = [:]
  for cp in manifest.controlPoints {
    if cp.id == .leftSleeve || cp.id == .rightSleeve { continue }
    targets[cp.id] = place(cp.u, cp.v)
  }

  // Sleeves articulate: placed along the actual upper-arm direction, never
  // stretched (own authored length, scaled by lateralScaleForLength), offset
  // outboard by the arm's half-width -- of the two perpendiculars, the one
  // pointing away from the body's midline (shoulderMidBody).
  for side in [true, false] {
    let seamCp = side ? leftShoulderCp : rightShoulderCp
    guard let seamTarget = targets[side ? .leftShoulder : .rightShoulder] else { continue }
    let joint = side ? anchors.leftShoulderPx : anchors.rightShoulderPx
    let elbow = side ? anchors.leftElbowPx : anchors.rightElbowPx
    guard let sleeveCp = manifest.controlPoint(side ? .leftSleeve : .rightSleeve) else { continue }
    let outward: Float = side ? -1 : 1

    let sleeveLengthTexture = Float(Foundation.hypot(
      Double((sleeveCp.u - seamCp.u) * Float(textureWidth)),
      Double((sleeveCp.v - seamCp.v) * Float(textureHeight))))
    let reach = sleeveLengthTexture * lateralScaleForLength

    let dir: Vec2
    if let elbow = elbow {
      let d = elbow - joint
      let len = d.length()
      if len < 1 { continue }
      dir = Vec2(d.x / len, d.y / len)
    } else {
      let f = Vec2(-upDir.x + rightDir.x * outward * 0.35, -upDir.y + rightDir.y * outward * 0.35)
      let len = f.length()
      dir = Vec2(f.x / len, f.y / len)
    }

    let candidate = Vec2(dir.y, -dir.x)
    let away = seamTarget - shoulderMidBody
    let sign: Float = dot(candidate, away) >= 0 ? 1 : -1
    let normal = candidate * sign
    let armOffset = anchors.shoulderSpanPx * c.upperArmHalfWidth

    targets[sleeveCp.id] = Vec2(
      seamTarget.x + dir.x * reach + normal.x * armOffset,
      seamTarget.y + dir.y * reach + normal.y * armOffset)
  }

  return ControlPointTargets(targets: targets, shoulderMidBody: shoulderMidBody, hemMidBody: hemMidBody)
}

public struct RigidPlacement: Equatable {
  public let scale: Float
  public let rotationRadians: Float
  public let translation: Vec2
}

/// Stage 3: exact similarity transform (uniform scale + rotation +
/// translation) fit from the two shoulder correspondences alone -- two
/// points determine a similarity uniquely, no least squares, no reflection.
public func fitRigidPlacement(
  manifest: KsgarmentManifest, targets: ControlPointTargets, textureWidth: Int, textureHeight: Int
) -> RigidPlacement? {
  guard let leftCp = manifest.controlPoint(.leftShoulder), let rightCp = manifest.controlPoint(.rightShoulder) else { return nil }
  // Garment-space points converted to real texture-pixel space before any
  // vector combining u and v.
  let leftPx = Vec2(leftCp.u * Float(textureWidth), leftCp.v * Float(textureHeight))
  let rightPx = Vec2(rightCp.u * Float(textureWidth), rightCp.v * Float(textureHeight))
  let srcVec = rightPx - leftPx
  guard let dstLeft = targets.targets[.leftShoulder], let dstRight = targets.targets[.rightShoulder] else { return nil }
  let dstVec = dstRight - dstLeft

  let scale = dstVec.length() / max(1e-6, srcVec.length())
  let rotation = atan2f(dstVec.y, dstVec.x) - atan2f(srcVec.y, srcVec.x)

  // translation such that srcLeft maps exactly onto dstLeft under (scale, rotation)
  let cosR = cosf(rotation)
  let sinR = sinf(rotation)
  let rotatedLeft = Vec2(leftPx.x * cosR - leftPx.y * sinR, leftPx.x * sinR + leftPx.y * cosR) * scale
  let translation = dstLeft - rotatedLeft

  return RigidPlacement(scale: scale, rotationRadians: rotation, translation: translation)
}

/// Applies a fitted similarity transform to a garment-texture-pixel-space point.
public func applySimilarity(_ placement: RigidPlacement, _ p: Vec2) -> Vec2 {
  let cosR = cosf(placement.rotationRadians) * placement.scale
  let sinR = sinf(placement.rotationRadians) * placement.scale
  return Vec2(p.x * cosR - p.y * sinR + placement.translation.x, p.x * sinR + p.y * cosR + placement.translation.y)
}

public struct RigidGateResult: Equatable {
  public let passed: Bool
  public let findings: [String]
}

/// Stage 4: gross-error detector, not a quality judgement -- deformation
/// cannot repair incorrect semantic anchoring. Faithful port of the
/// reference's five checks, including its choice to gate against the RIGID
/// placement of the garment's own control points (via `applySimilarity`),
/// not against the deformed targets.
public func evaluateRigidGate(
  anchors: BodyAnchors, manifest: KsgarmentManifest, placement: RigidPlacement,
  textureWidth: Int, textureHeight: Int
) -> RigidGateResult {
  var findings: [String] = []

  func place(_ id: GarmentControlPointId) -> Vec2? {
    guard let cp = manifest.controlPoint(id) else { return nil }
    return applySimilarity(placement, Vec2(cp.u * Float(textureWidth), cp.v * Float(textureHeight)))
  }
  guard let gLeftShoulder = place(.leftShoulder) else {
    return RigidGateResult(passed: false, findings: [LiveVtoGeometryPipeline.Refusal.missingGarmentControlPoints])
  }
  guard let gRightShoulder = place(.rightShoulder) else {
    return RigidGateResult(passed: false, findings: [LiveVtoGeometryPipeline.Refusal.missingGarmentControlPoints])
  }
  let gLeftHem = place(.leftHem)
  let gRightHem = place(.rightHem)

  let bodyAxis = anchors.rightShoulderPx - anchors.leftShoulderPx
  let garmentAxis = gRightShoulder - gLeftShoulder
  if dot(bodyAxis, garmentAxis) <= 0 { findings.append("left_right_inversion") }

  let garmentShoulderSpanPx = garmentAxis.length()
  let scaleRatio = garmentShoulderSpanPx / anchors.shoulderSpanPx

  let downX = -bodyAxis.y / anchors.shoulderSpanPx
  let downY = bodyAxis.x / anchors.shoulderSpanPx
  let shoulderMidGarment = Vec2((gLeftShoulder.x + gRightShoulder.x) / 2, (gLeftShoulder.y + gRightShoulder.y) / 2)
  if let gLeftHem = gLeftHem, let gRightHem = gRightHem {
    let hemMidGarment = Vec2((gLeftHem.x + gRightHem.x) / 2, (gLeftHem.y + gRightHem.y) / 2)
    let hemBelowShoulderPx = (hemMidGarment.x - shoulderMidGarment.x) * downX + (hemMidGarment.y - shoulderMidGarment.y) * downY
    if hemBelowShoulderPx <= 0 { findings.append("upside_down") }
  }

  if scaleRatio < 0.55 || scaleRatio > 1.8 { findings.append("gross_scale_error") }

  let necklineTolerancePx = anchors.shoulderSpanPx * 0.55
  let necklineToNeckBasePx = (shoulderMidGarment - anchors.neckBasePx).length()
  if necklineToNeckBasePx > necklineTolerancePx { findings.append("neckline_outside_upper_torso") }

  let torsoCentroid = Vec2(
    (anchors.leftShoulderPx.x + anchors.rightShoulderPx.x + anchors.leftHipPx.x + anchors.rightHipPx.x) / 4,
    (anchors.leftShoulderPx.y + anchors.rightShoulderPx.y + anchors.leftHipPx.y + anchors.rightHipPx.y) / 4)
  let garmentPoints = [gLeftShoulder, gRightShoulder, gLeftHem, gRightHem].compactMap { $0 }
  let garmentSum = garmentPoints.reduce(Vec2(0, 0)) { $0 + $1 }
  let garmentCentroid = Vec2(garmentSum.x / Float(garmentPoints.count), garmentSum.y / Float(garmentPoints.count))
  let torsoDiagonalPx = Float(Foundation.hypot(Double(anchors.shoulderSpanPx), Double(anchors.torsoHeightPx)))
  if (garmentCentroid - torsoCentroid).length() > torsoDiagonalPx * 0.5 { findings.append("garment_largely_outside_torso") }

  return RigidGateResult(passed: findings.isEmpty, findings: findings)
}
