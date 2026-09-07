import Foundation

/// Maps a provider-agnostic `RawPoseFrame` (BlazePose/MediaPipe Pose 33-point
/// topology, see `PoseLandmarkIndex`) into the governed `BodyFrame` contract.
/// Field-for-field port of Android's `LiveVtoBodyFrameAdapter.kt`.
///
/// Zero UIKit/platform dependencies -- this file is pure Swift so the
/// mapping logic, the left/right canary, the non-finite guard, and the
/// missing-landmark policy are all runnable in a plain SwiftPM host test,
/// independent of whether a real device or simulator can execute the model.
///
/// ── Coordinate convention ────────────────────────────────────────────────
///
/// `BodyFrame`'s own contract is documented as front-camera-mirrored: "the
/// wearer's own left is at the LOWER u." That describes what a LIVE CAMERA
/// frame is expected to look like once front-camera work applies its own
/// mirror transform at the camera-input stage -- it is NOT something this
/// adapter applies. This adapter does a DIRECT, unflipped, 1:1 mapping:
/// MediaPipe's own `left_shoulder` (index 11) becomes `BodyFrame.leftShoulder`,
/// exactly as reported, with no horizontal flip introduced here. Whatever
/// left/right relationship exists in the INPUT frame is exactly what ends up
/// in BodyFrame -- mirroring belongs to the later camera-input transform
/// layer, not to this adapter, on both platforms.
///
/// ── Absent vs. non-finite vs. low-confidence ────────────────────────────
///
/// Three distinct input conditions, three distinct outcomes -- carrying
/// forward the lesson Android's N1-ENV-008 already established for BodyFrame
/// geometry, applied one layer earlier, at the perception boundary itself:
///
///   - `present = false` (provider did not report this landmark at all) ->
///     `.absent`. A provider saying "I did not observe this" is working
///     correctly.
///   - `present = true` but x/y/confidence is NaN or infinite -> the WHOLE
///     FRAME is rejected as `.invalidProviderOutput`, never partially mapped.
///     A provider that is up and reporting garbage is broken, not merely
///     uncertain, and this must be classified distinctly from "landmark
///     absent."
///   - `present = true`, finite, but `confidence < minimumLandmarkConfidence`
///     -> treated as `.absent` for CRITICAL landmarks (shoulders, hips). This
///     is a deliberate, documented policy choice: feeding a
///     low-confidence-but-present coordinate into a rigid geometric fit is
///     exactly "the renderer treating unreliable geometry as strong
///     tracking." Demoting it to absent lets the EXISTING, already-hardened
///     geometry pipeline (`missing_hips`/`missing_shoulders` refusal paths)
///     handle it, rather than inventing a second fail-closed mechanism.
public enum LiveVtoBodyFrameAdapter {

  /// PROVISIONAL: no pre-existing governed threshold for perception-provider
  /// confidence exists anywhere else in this codebase, so this is a new,
  /// explicitly-labelled starting point (matching Android's own value), not
  /// a calibrated one. Applied uniformly to every landmark this adapter
  /// reads, critical or not, for consistency.
  public static let minimumLandmarkConfidence: Float = 0.5

  public enum Result {
    case mapped(frame: BodyFrame)
    /// Provider ran; frame is well-formed; no further action needed from the caller beyond noting the reason.
    case noUsablePose(reason: String)
    /// The provider reported NaN/Infinity somewhere. Fail closed -- never map, never guess, never partially render.
    case invalidProviderOutput(reason: String)
  }

  public static func adapt(_ raw: RawPoseFrame) -> Result {
    if raw.landmarks.count < PoseLandmarkIndex.count {
      return .noUsablePose(reason: "landmark list too short: \(raw.landmarks.count) < \(PoseLandmarkIndex.count)")
    }
    if !raw.poseConfidence.isFinite {
      return .invalidProviderOutput(reason: "non-finite poseConfidence: \(raw.poseConfidence)")
    }

    // Non-finite check FIRST, across every reported landmark, before any
    // mapping decision is made -- one bad float anywhere fails the whole
    // frame closed.
    for (index, lm) in raw.landmarks.enumerated() {
      if !lm.present { continue }
      if !lm.x.isFinite || !lm.y.isFinite || !lm.confidence.isFinite {
        return .invalidProviderOutput(reason: "non-finite landmark at index \(index): x=\(lm.x) y=\(lm.y) confidence=\(lm.confidence)")
      }
    }

    func landmarkAt(_ index: Int, isCritical: Bool) -> Landmark {
      let lm = raw.landmarks[index]
      if !lm.present { return .absent }
      if isCritical && lm.confidence < minimumLandmarkConfidence { return .absent }
      return .present(point: Vec2(lm.x, lm.y), confidence: lm.confidence)
    }

    let leftShoulder = landmarkAt(PoseLandmarkIndex.leftShoulder, isCritical: true)
    let rightShoulder = landmarkAt(PoseLandmarkIndex.rightShoulder, isCritical: true)
    let leftHip = landmarkAt(PoseLandmarkIndex.leftHip, isCritical: true)
    let rightHip = landmarkAt(PoseLandmarkIndex.rightHip, isCritical: true)
    let leftElbow = landmarkAt(PoseLandmarkIndex.leftElbow, isCritical: false)
    let rightElbow = landmarkAt(PoseLandmarkIndex.rightElbow, isCritical: false)
    let leftWrist = landmarkAt(PoseLandmarkIndex.leftWrist, isCritical: false)
    let rightWrist = landmarkAt(PoseLandmarkIndex.rightWrist, isCritical: false)
    let nose = landmarkAt(PoseLandmarkIndex.nose, isCritical: false)

    if !leftShoulder.isPresent && !rightShoulder.isPresent && !leftHip.isPresent && !rightHip.isPresent {
      return .noUsablePose(reason: "no critical landmarks usable (all absent or below confidence threshold)")
    }

    // ── Derived proxies (neck/chest/waist/torso center+width+height+rotation) ──
    //
    // Not part of the raw pose topology -- BlazePose has no dedicated
    // neck/chest/waist landmark. These are simple midpoint/distance/angle
    // derivations, following the exact same precedent and caveat as the
    // canned `BodyFrame.neutral()` fixture: the real geometry pipeline
    // (`extractBodyAnchors`) computes its own anchors directly from
    // shoulder/hip/elbow/neck landmarks and does NOT consume these derived
    // fields, so an approximation here is not load-bearing for placement.
    // Only computed when both shoulders (or both hips) are actually present;
    // left absent rather than guessed otherwise.
    let ls = leftShoulder.pointOrNull
    let rs = rightShoulder.pointOrNull
    let lh = leftHip.pointOrNull
    let rh = rightHip.pointOrNull

    let shoulderMid = (ls != nil && rs != nil) ? Vec2((ls!.x + rs!.x) / 2, (ls!.y + rs!.y) / 2) : nil
    let hipMid = (lh != nil && rh != nil) ? Vec2((lh!.x + rh!.x) / 2, (lh!.y + rh!.y) / 2) : nil
    let shoulderSpan = (ls != nil && rs != nil) ? (rs! - ls!).length() : nil

    let neckCenter: Landmark
    if let shoulderMid = shoulderMid, let shoulderSpan = shoulderSpan,
       case .present(_, let lc) = leftShoulder, case .present(_, let rc) = rightShoulder {
      neckCenter = .present(point: Vec2(shoulderMid.x, shoulderMid.y - shoulderSpan * 0.12), confidence: min(lc, rc))
    } else {
      neckCenter = .absent
    }
    let chestCenter: Landmark
    if let shoulderMid = shoulderMid, let hipMid = hipMid {
      chestCenter = .present(point: Vec2((shoulderMid.x + hipMid.x) / 2, shoulderMid.y + (hipMid.y - shoulderMid.y) * 0.3), confidence: 1)
    } else {
      chestCenter = .absent
    }
    let waistCenter: Landmark = hipMid.map { .present(point: $0, confidence: 1) } ?? .absent
    let torsoCenter: Landmark
    if let shoulderMid = shoulderMid, let hipMid = hipMid {
      torsoCenter = .present(point: Vec2((shoulderMid.x + hipMid.x) / 2, (shoulderMid.y + hipMid.y) / 2), confidence: 1)
    } else {
      torsoCenter = .absent
    }
    let torsoWidth = shoulderSpan
    let torsoHeight: Float? = (shoulderMid != nil && hipMid != nil)
      ? Float(Foundation.hypot(Double(hipMid!.x - shoulderMid!.x), Double(hipMid!.y - shoulderMid!.y)))
      : nil
    let torsoRotation: Float? = (ls != nil && rs != nil) ? atan2f(rs!.y - ls!.y, rs!.x - ls!.x) : nil

    let headCenter: Landmark
    switch nose {
    case .present: headCenter = nose
    case .absent: headCenter = neckCenter // reasonable proxy only when nose itself is absent; never invents a position when neck is also absent
    }

    let criticalConfidences: [Float] = [leftShoulder, rightShoulder, leftHip, rightHip].compactMap {
      if case .present(_, let c) = $0 { return c }
      return nil
    }
    let trackingConfidence = criticalConfidences.isEmpty ? 0 : criticalConfidences.min()!

    let bodyFrame = BodyFrame(
      timestampMs: raw.timestampMs,
      headCenter: headCenter,
      noseOrHeadDirection: nose,
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
      trackingConfidence: trackingConfidence)
    return .mapped(frame: bodyFrame)
  }
}
