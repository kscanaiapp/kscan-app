package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveVtoCapabilityStagesTest {
  private val allGood = LiveVtoCapabilityStages.Inputs(
    sdkInt = 34, frontCameraPresent = true, modelAssetPresent = true, cameraPermissionGranted = true,
  )

  @Suppress("UNCHECKED_CAST")
  private fun stages(result: Map<String, Any?>) = result["stages"] as Map<String, Any?>

  @Test
  fun theShippedGateIsClosed() {
    assertFalse(LiveVtoCapabilityStages.PHYSICAL_CERTIFICATION_APPROVED)
  }

  @Test
  fun registrationAndEveryStageTrueStillAdvertisesNothingWhileUncertified() {
    val result = LiveVtoCapabilityStages.evaluate(allGood, "n1-a")
    assertEquals(false, result["capable"])
    assertEquals(false, result["runtimeReady"])
    val s = stages(result)
    assertEquals(true, s["moduleRegistered"])
    assertEquals(true, s["platformSupported"])
    assertEquals(true, s["frontCameraPresent"])
    assertEquals(true, s["modelAssetPresent"])
    assertEquals("granted", s["cameraPermission"])
    assertEquals("not_approved", s["physicalCertification"])
  }

  @Test
  fun stagesReportTheMissingPrerequisiteIndividually() {
    val noModel = stages(LiveVtoCapabilityStages.evaluate(allGood.copy(modelAssetPresent = false), null))
    assertEquals(false, noModel["modelAssetPresent"])
    assertEquals(true, noModel["frontCameraPresent"])
    val noCamera = stages(LiveVtoCapabilityStages.evaluate(allGood.copy(frontCameraPresent = false), null))
    assertEquals(false, noCamera["frontCameraPresent"])
    val oldOs = stages(LiveVtoCapabilityStages.evaluate(allGood.copy(sdkInt = 23), null))
    assertEquals(false, oldOs["platformSupported"])
    val noPermission = stages(LiveVtoCapabilityStages.evaluate(allGood.copy(cameraPermissionGranted = false), null))
    assertEquals("not_granted", noPermission["cameraPermission"])
  }

  @Test
  fun whenApprovedEveryPrerequisiteIsStillRequired() {
    val ok = LiveVtoCapabilityStages.evaluate(allGood, "v", certified = true)
    assertEquals(true, ok["capable"])
    assertEquals(true, ok["runtimeReady"])
    // No model: capable hardware, but the runtime's resources are not ready.
    val noModel = LiveVtoCapabilityStages.evaluate(allGood.copy(modelAssetPresent = false), "v", certified = true)
    assertEquals(true, noModel["capable"])
    assertEquals(false, noModel["runtimeReady"])
    // No front camera, old OS: not capable, therefore not ready.
    for (bad in listOf(allGood.copy(frontCameraPresent = false), allGood.copy(sdkInt = 23))) {
      val r = LiveVtoCapabilityStages.evaluate(bad, "v", certified = true)
      assertEquals(false, r["capable"])
      assertEquals(false, r["runtimeReady"])
    }
  }

  @Test
  fun cameraPermissionIsNotACapabilityInput() {
    // It is requested on an explicit customer action, so a not-yet-granted
    // permission must not make an otherwise eligible device read as incapable.
    val r = LiveVtoCapabilityStages.evaluate(allGood.copy(cameraPermissionGranted = false), "v", certified = true)
    assertEquals(true, r["capable"])
  }

  @Test
  fun noPostStartStageIsReportedBeforeAnySessionExists() {
    val keys = stages(LiveVtoCapabilityStages.evaluate(allGood, "v")).keys
    for (forbidden in listOf("framesDelivered", "framesConsumed", "perceptionFunctioning", "rendererPainting", "cameraSessionInitialized")) {
      assertTrue("$forbidden cannot be known before start()", forbidden !in keys)
    }
  }
}
