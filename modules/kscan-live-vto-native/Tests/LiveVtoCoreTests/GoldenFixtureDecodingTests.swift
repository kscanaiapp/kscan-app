import XCTest
@testable import LiveVtoCore

/// Regression controls for the `GoldenFixtures.decodeLandmark`/`RawCase`
/// JSON-null decoding defect: `entry["landmarks"] as? [String: [Any]]`
/// requires EVERY value in the dictionary to cast to `[Any]`, but a JSON
/// `null` (any absent landmark, e.g. `"leftShoulder": null`) arrives from
/// `JSONSerialization` as `NSNull`, which fails that cast -- for the WHOLE
/// dictionary, not just the null key. Every golden case carrying even one
/// null landmark (`partial-wrist`, `missing-elbows`, `missing-left-elbow`,
/// and every refusal case by construction) was silently seeing every OTHER
/// landmark as absent too, which is why they all failed with
/// `missing_shoulders` regardless of their actual content or documented
/// expected reason.
///
/// These tests exercise the decoder directly, independent of the geometry
/// pipeline and independent of the real `goldens/bodyframes.json` file
/// (constructing minimal `[String: Any]` maps by hand), so a future change
/// to the decoder cannot silently regress this class of defect even if the
/// golden file's own case mix changes.
final class GoldenFixtureDecodingTests: XCTestCase {

  private func present(_ u: Float, _ v: Float) -> [Any] { [u, v] }

  /// NC-1: a case with valid shoulders and hips but one absent (null) wrist
  /// must preserve the shoulders/hips as present -- it must NOT be
  /// misdecoded as `missing_shoulders`.
  func testNC1_PartialWristPreservesShouldersAndHips() {
    let landmarks: [String: Any] = [
      "leftShoulder": present(0.38, 0.28),
      "rightShoulder": present(0.62, 0.28),
      "leftHip": present(0.40, 0.60),
      "rightHip": present(0.60, 0.60),
      "leftWrist": NSNull(),
    ]
    let raw = GoldenFixtures.RawCase(id: "nc1-partial-wrist", note: nil, landmarks: landmarks, expectedFailure: nil, expectedGateFindings: nil)
    let frame = GoldenFixtures.bodyFrame(raw)
    XCTAssertTrue(frame.leftShoulder.isPresent, "a null wrist must not erase the shoulders")
    XCTAssertTrue(frame.rightShoulder.isPresent)
    XCTAssertTrue(frame.leftHip.isPresent)
    XCTAssertTrue(frame.rightHip.isPresent)
    XCTAssertEqual(frame.leftWrist, .absent)
  }

  /// NC-2: null elbows must decode to absent elbows only -- shoulders and
  /// hips remain present and geometry-eligible.
  func testNC2_MissingElbowsStayAbsentWithoutErasingShouldersOrHips() {
    let landmarks: [String: Any] = [
      "leftShoulder": present(0.38, 0.28),
      "rightShoulder": present(0.62, 0.28),
      "leftHip": present(0.40, 0.60),
      "rightHip": present(0.60, 0.60),
      "leftElbow": NSNull(),
      "rightElbow": NSNull(),
    ]
    let raw = GoldenFixtures.RawCase(id: "nc2-missing-elbows", note: nil, landmarks: landmarks, expectedFailure: nil, expectedGateFindings: nil)
    let frame = GoldenFixtures.bodyFrame(raw)
    XCTAssertEqual(frame.leftElbow, .absent)
    XCTAssertEqual(frame.rightElbow, .absent)
    XCTAssertTrue(frame.leftShoulder.isPresent)
    XCTAssertTrue(frame.rightShoulder.isPresent)
    XCTAssertTrue(frame.leftHip.isPresent)
    XCTAssertTrue(frame.rightHip.isPresent)
  }

  /// NC-3: same rule for one-sided absence -- a single null elbow must not
  /// disturb its own present pair or any other landmark.
  func testNC3_MissingLeftElbowOnlyAffectsThatLandmark() {
    let landmarks: [String: Any] = [
      "leftShoulder": present(0.38, 0.28),
      "rightShoulder": present(0.62, 0.28),
      "leftHip": present(0.40, 0.60),
      "rightHip": present(0.60, 0.60),
      "leftElbow": NSNull(),
      "rightElbow": present(0.68, 0.45),
    ]
    let raw = GoldenFixtures.RawCase(id: "nc3-missing-left-elbow", note: nil, landmarks: landmarks, expectedFailure: nil, expectedGateFindings: nil)
    let frame = GoldenFixtures.bodyFrame(raw)
    XCTAssertEqual(frame.leftElbow, .absent)
    XCTAssertTrue(frame.rightElbow.isPresent, "the sibling landmark must not be erased by the null on the other side")
    XCTAssertTrue(frame.leftShoulder.isPresent)
    XCTAssertTrue(frame.rightShoulder.isPresent)
  }

  /// NC-4: valid shoulders with null hips must reach the geometry pipeline's
  /// OWN `missing_hips` refusal -- not a decoder-level `missing_shoulders`
  /// masking the real, documented reason.
  func testNC4_MissingHipsReachesGeometryAsMissingHipsNotMissingShoulders() throws {
    let landmarks: [String: Any] = [
      "leftShoulder": present(0.38, 0.28),
      "rightShoulder": present(0.62, 0.28),
      "leftHip": NSNull(),
      "rightHip": NSNull(),
    ]
    let raw = GoldenFixtures.RawCase(id: "nc4-missing-hips", note: nil, landmarks: landmarks, expectedFailure: "missing_hips", expectedGateFindings: nil)
    let frame = GoldenFixtures.bodyFrame(raw)
    XCTAssertTrue(frame.leftShoulder.isPresent)
    XCTAssertTrue(frame.rightShoulder.isPresent)
    XCTAssertEqual(frame.leftHip, .absent)
    XCTAssertEqual(frame.rightHip, .absent)

    let (manifest, texW, texH) = try GoldenFixtures.loadManifest(fixture: "n1b-fixture")
    let snapshot = LiveVtoGeometryPipeline.compute(manifest: manifest, frame: frame, bodyFrameId: raw.id, canvasWidth: 720, canvasHeight: 960, textureWidth: texW, textureHeight: texH)
    XCTAssertEqual(snapshot.failure, LiveVtoGeometryPipeline.Refusal.missingHips, "a null-hips case must refuse as missing_hips, not missing_shoulders")
  }

  /// NC-5: the specific defect mechanism -- ONE null value anywhere in the
  /// map must not collapse every OTHER key to absent. Directly exercises
  /// every field of a fully-populated frame with exactly one null landmark
  /// mixed in, proving the dictionary-level cast failure this test file
  /// exists to guard against cannot recur.
  func testNC5_OneNullLandmarkDoesNotZeroTheWholeMap() {
    let landmarks: [String: Any] = [
      "headCenter": present(0.5, 0.15),
      "neckCenter": present(0.5, 0.22),
      "leftShoulder": present(0.38, 0.28),
      "rightShoulder": present(0.62, 0.28),
      "leftElbow": present(0.32, 0.45),
      "rightElbow": present(0.68, 0.45),
      "leftWrist": present(0.30, 0.60),
      "rightWrist": NSNull(), // the single null in an otherwise fully-populated map
      "leftHip": present(0.40, 0.60),
      "rightHip": present(0.60, 0.60),
    ]
    let raw = GoldenFixtures.RawCase(id: "nc5-single-null", note: nil, landmarks: landmarks, expectedFailure: nil, expectedGateFindings: nil)
    let frame = GoldenFixtures.bodyFrame(raw)

    XCTAssertTrue(frame.headCenter.isPresent)
    XCTAssertTrue(frame.neckCenter.isPresent)
    XCTAssertTrue(frame.leftShoulder.isPresent)
    XCTAssertTrue(frame.rightShoulder.isPresent)
    XCTAssertTrue(frame.leftElbow.isPresent)
    XCTAssertTrue(frame.rightElbow.isPresent)
    XCTAssertTrue(frame.leftWrist.isPresent)
    XCTAssertTrue(frame.leftHip.isPresent)
    XCTAssertTrue(frame.rightHip.isPresent)
    // Only the actually-null field is absent.
    XCTAssertEqual(frame.rightWrist, .absent)
  }

  /// NC-6: a present-but-non-finite landmark (the golden file's "NaN"/
  /// "Infinity"/"-Infinity" string encoding) must decode as PRESENT with a
  /// non-finite coordinate, never silently downgraded to absent -- absence
  /// and "provider reported garbage" are different conditions with
  /// different fail-closed handling downstream (`missing_shoulders` vs.
  /// `non_finite_landmark`), and only the geometry pipeline is entitled to
  /// collapse one into a refusal.
  func testNC6_NonFiniteLandmarkStaysPresentNotAbsent() {
    let landmarks: [String: Any] = [
      "leftShoulder": ["NaN", 0.28] as [Any],
      "rightShoulder": present(0.62, 0.28),
      "leftHip": present(0.40, 0.60),
      "rightHip": ["Infinity", 0.6] as [Any],
    ]
    let raw = GoldenFixtures.RawCase(id: "nc6-non-finite", note: nil, landmarks: landmarks, expectedFailure: "non_finite_landmark", expectedGateFindings: nil)
    let frame = GoldenFixtures.bodyFrame(raw)

    guard case .present(let ls, _) = frame.leftShoulder else {
      return XCTFail("a non-finite-but-reported landmark must decode as .present, not .absent")
    }
    XCTAssertTrue(ls.x.isNaN)
    guard case .present(let rh, _) = frame.rightHip else {
      return XCTFail("a non-finite-but-reported landmark must decode as .present, not .absent")
    }
    XCTAssertTrue(rh.x.isInfinite)
  }
}
