import XCTest
@testable import LiveVtoCore

/// The governed-asset resolver's native half, iOS side. Field-for-field port
/// of Android's `LiveVtoGarmentDescriptorTest.kt` -- see that file for the
/// full rationale. `fromBridgeMap` and `assetIdentityMatches` have zero
/// UIKit/ExpoModulesCore imports (LiveVtoRuntimeBoundaryTests.swift), so this
/// is real production parsing logic under test via `swift test`, not a model
/// of it.
final class LiveVtoGarmentDescriptorTests: XCTestCase {

  private func validMap(_ overrides: [String: Any] = [:]) -> [String: Any] {
    var base: [String: Any] = [
      "productRef": "prod-1",
      "imageUrl": "https://cdn.example.com/tee.jpg",
      "canonicalCategory": "top",
      "templateFamily": "simple-top",
      "assetKey": "n1b-fixture",
      "assetId": "081350cef7f5c83e05c3e6c1",
      "assetVersion": "1",
    ]
    for (key, value) in overrides { base[key] = value }
    return base
  }

  // MARK: - Happy path

  func testAFullyValidDescriptorParsesWithAllSevenFields() {
    let parsed = LiveVtoGarmentDescriptor.fromBridgeMap(validMap())
    XCTAssertNotNil(parsed)
    XCTAssertEqual(parsed?.productRef, "prod-1")
    XCTAssertEqual(parsed?.assetKey, "n1b-fixture")
    XCTAssertEqual(parsed?.assetId, "081350cef7f5c83e05c3e6c1")
    XCTAssertEqual(parsed?.assetVersion, "1")
  }

  func testTheOtherAllowlistedAssetKeyAlsoParses() {
    let parsed = LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["assetKey": "n1c-asym-fixture"]))
    XCTAssertEqual(parsed?.assetKey, "n1c-asym-fixture")
  }

  // MARK: - The closed gap: no assetKey, no load

  func testADescriptorWithNoAssetKeyAtAllIsRefused_theOldPlaceholderShapeNoLongerParses() {
    // Exactly the four-field shape the placeholder used to accept
    // unconditionally. Proving it now returns nil is the hard negative
    // control for "no silent fixture fallback".
    let legacyShape: [String: Any] = [
      "productRef": "prod-1",
      "imageUrl": "https://cdn.example.com/tee.jpg",
      "canonicalCategory": "top",
      "templateFamily": "simple-top",
    ]
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(legacyShape))
  }

  func testAnAssetKeyNotOnTheAllowlistIsRefused() {
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["assetKey": "n1b-fixture-typo"])))
  }

  func testAPathTraversalShapedAssetKeyIsRefused() {
    for hostile in ["../../etc/passwd", "n1b-fixture/../../secrets", "/etc/passwd", "n1b-fixture/.."] {
      XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["assetKey": hostile])), "hostile assetKey must be refused: \(hostile)")
    }
  }

  func testABlankAssetIdIsRefused() {
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["assetId": ""])))
  }

  func testAMissingAssetIdIsRefused() {
    var map = validMap()
    map.removeValue(forKey: "assetId")
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(map))
  }

  func testABlankAssetVersionIsRefused() {
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["assetVersion": ""])))
  }

  func testTheExistingChecksStillApply_missingProductRefImageOrUnsupportedTemplateFamily() {
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["productRef": ""])))
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["imageUrl": ""])))
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["templateFamily": "outerwear"])))
    XCTAssertNil(LiveVtoGarmentDescriptor.fromBridgeMap(nil))
  }

  // MARK: - assetIdentityMatches

  private func manifest(assetVersion: String) -> KsgarmentManifest {
    KsgarmentManifest(
      version: KSGARMENT_SCHEMA_VERSION,
      productId: "whatever-the-manifest-says",
      category: "top",
      controlPoints: [
        GarmentControlPoint(id: .leftShoulder, u: 0.1, v: 0.1),
        GarmentControlPoint(id: .rightShoulder, u: 0.9, v: 0.1),
        GarmentControlPoint(id: .leftHem, u: 0.1, v: 0.9),
        GarmentControlPoint(id: .rightHem, u: 0.9, v: 0.9),
      ],
      meshDefinition: MeshDefinition(width: 8, height: 10),
      texture: "texture.png",
      alphaMask: "alpha.png",
      assetVersion: assetVersion)
  }

  func testAssetIdentityMatches_trueWhenManifestVersionEqualsDescriptorVersion() {
    let descriptor = LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["assetVersion": "1"]))!
    XCTAssertTrue(assetIdentityMatches(manifest(assetVersion: "1"), descriptor))
  }

  func testAssetIdentityMatches_falseWhenTheLoadedManifestIsADifferentVersionThanRequested() {
    let descriptor = LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["assetVersion": "1"]))!
    XCTAssertFalse(assetIdentityMatches(manifest(assetVersion: "2"), descriptor))
  }

  func testAssetIdentityMatches_isIndifferentToProductIdVsProductRef_differentIdentitySpacesByDesign() {
    let descriptor = LiveVtoGarmentDescriptor.fromBridgeMap(validMap(["productRef": "prod-1", "assetVersion": "7"]))!
    XCTAssertTrue(assetIdentityMatches(manifest(assetVersion: "7"), descriptor))
  }
}
