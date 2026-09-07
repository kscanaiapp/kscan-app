package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The governed-asset resolver's native half: `LiveVtoGarmentDescriptor`
 * closes the loadGarment/switchGarment placeholder
 * (docs/vto-live-bridge-contract.md §13.5) by REQUIRING a valid,
 * allowlisted `assetKey` -- a descriptor that would previously have
 * silently loaded the bundled fixture regardless of content now fails to
 * parse at all. Pure JVM tests: `fromBridgeMap` and `assetIdentityMatches`
 * have zero Android imports (see this file's siblings,
 * RuntimeBoundaryTest.kt), so this is real production parsing logic under
 * test, not a model of it.
 */
class LiveVtoGarmentDescriptorTest {

  private fun validMap(overrides: Map<String, Any?> = emptyMap()): Map<String, Any?> {
    val base = mapOf<String, Any?>(
      "productRef" to "prod-1",
      "imageUrl" to "https://cdn.example.com/tee.jpg",
      "canonicalCategory" to "top",
      "templateFamily" to "simple-top",
      "assetKey" to "n1b-fixture",
      "assetId" to "081350cef7f5c83e05c3e6c1",
      "assetVersion" to "1",
    )
    return base + overrides
  }

  // ── Happy path ──────────────────────────────────────────────────────────

  @Test
  fun aFullyValidDescriptorParsesWithAllSevenFields() {
    val parsed = LiveVtoGarmentDescriptor.fromBridgeMap(validMap())
    assertTrue(parsed != null)
    assertEquals("prod-1", parsed!!.productRef)
    assertEquals("n1b-fixture", parsed.assetKey)
    assertEquals("081350cef7f5c83e05c3e6c1", parsed.assetId)
    assertEquals("1", parsed.assetVersion)
  }

  @Test
  fun theOtherAllowlistedAssetKeyAlsoParses() {
    val parsed = LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetKey" to "n1c-asym-fixture")))
    assertTrue(parsed != null)
    assertEquals("n1c-asym-fixture", parsed!!.assetKey)
  }

  // ── The closed gap: no assetKey, no load ───────────────────────────────

  @Test
  fun aDescriptorWithNoAssetKeyAtAllIsRefused_theOldPlaceholderShapeNoLongerParses() {
    // This is EXACTLY the four-field shape the placeholder used to accept
    // unconditionally (productRef/imageUrl/canonicalCategory/templateFamily
    // only). Proving it now returns null is the hard negative control for
    // "no silent fixture fallback": without a valid assetKey, native cannot
    // reach loadFixture() for ANY folder.
    val legacyShape = mapOf<String, Any?>(
      "productRef" to "prod-1",
      "imageUrl" to "https://cdn.example.com/tee.jpg",
      "canonicalCategory" to "top",
      "templateFamily" to "simple-top",
    )
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(legacyShape))
  }

  @Test
  fun anAssetKeyNotOnTheAllowlistIsRefused() {
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetKey" to "n1b-fixture-typo"))))
  }

  @Test
  fun aPathTraversalShapedAssetKeyIsRefused() {
    for (hostile in listOf("../../etc/passwd", "n1b-fixture/../../secrets", "/etc/passwd", "n1b-fixture/..")) {
      assertNull("hostile assetKey must be refused: $hostile", LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetKey" to hostile))))
    }
  }

  @Test
  fun aBlankAssetIdIsRefused() {
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetId" to ""))))
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetId" to null))))
  }

  @Test
  fun aBlankAssetVersionIsRefused() {
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetVersion" to ""))))
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetVersion" to null))))
  }

  @Test
  fun theExistingChecksStillApply_missingProductRefImageOrUnsupportedTemplateFamily() {
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("productRef" to ""))))
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("imageUrl" to ""))))
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("templateFamily" to "outerwear"))))
    assertNull(LiveVtoGarmentDescriptor.fromBridgeMap(null))
  }

  // ── assetIdentityMatches ────────────────────────────────────────────────

  private fun manifest(assetVersion: String) = KsgarmentManifest(
    version = KSGARMENT_SCHEMA_VERSION,
    productId = "whatever-the-manifest-says",
    category = "top",
    controlPoints = listOf(
      GarmentControlPoint(GarmentControlPointId.LEFT_SHOULDER, 0.1f, 0.1f),
      GarmentControlPoint(GarmentControlPointId.RIGHT_SHOULDER, 0.9f, 0.1f),
      GarmentControlPoint(GarmentControlPointId.LEFT_HEM, 0.1f, 0.9f),
      GarmentControlPoint(GarmentControlPointId.RIGHT_HEM, 0.9f, 0.9f),
    ),
    meshDefinition = MeshDefinition(8, 10),
    texture = "texture.png",
    alphaMask = "alpha.png",
    assetVersion = assetVersion,
  )

  @Test
  fun assetIdentityMatches_trueWhenManifestVersionEqualsDescriptorVersion() {
    val descriptor = LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetVersion" to "1")))!!
    assertTrue(assetIdentityMatches(manifest("1"), descriptor))
  }

  @Test
  fun assetIdentityMatches_falseWhenTheLoadedManifestIsADifferentVersionThanRequested() {
    val descriptor = LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("assetVersion" to "1")))!!
    assertFalse(assetIdentityMatches(manifest("2"), descriptor))
  }

  @Test
  fun assetIdentityMatches_isIndifferentToProductIdVsProductRef_differentIdentitySpacesByDesign() {
    // manifest.productId ("whatever-the-manifest-says") intentionally never
    // equals descriptor.productRef ("prod-1") here -- see this function's
    // own doc comment in LiveVtoGarment.kt. Only assetVersion must agree.
    val descriptor = LiveVtoGarmentDescriptor.fromBridgeMap(validMap(mapOf("productRef" to "prod-1", "assetVersion" to "7")))!!
    assertTrue(assetIdentityMatches(manifest("7"), descriptor))
  }
}
