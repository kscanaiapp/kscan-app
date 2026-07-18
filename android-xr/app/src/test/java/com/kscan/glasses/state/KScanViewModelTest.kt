package com.kscan.glasses.state

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeRequest
import com.kscan.glasses.bridge.BridgeMessageType
import com.kscan.glasses.bridge.CaptureException
import com.kscan.glasses.bridge.CaptureResult
import com.kscan.glasses.bridge.CaptureSource
import com.kscan.glasses.bridge.DeviceCapabilities
import com.kscan.glasses.bridge.DeviceState
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.mobilebridge.MockMobileAppBridge
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.SanitizeResult
import com.kscan.glasses.scan.ScanOrchestrator
import com.kscan.glasses.testing.MainDispatcherRule
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class KScanViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun createViewModel(
        bridge: GlassesBridgeProvider = mockk(relaxed = true),
        analyzeClient: AnalyzeClient = mockk(relaxed = true),
        sanitizer: PrivacyImageSanitizer = mockk(relaxed = true),
    ): KScanViewModel {
        val orchestrator = ScanOrchestrator(
            sanitizer = sanitizer,
            analyzeClient = analyzeClient,
            mobileBridge = MockMobileAppBridge(),
            config = BetaConfig.DEFAULT,
            ioDispatcher = UnconfinedTestDispatcher(),
        )
        return KScanViewModel(
            bridge = bridge,
            orchestrator = orchestrator,
        )
    }

    private fun defaultBridgeState(hasDisplay: Boolean = true) = DeviceState(
        connected = true,
        batteryPercent = 87,
        capabilities = DeviceCapabilities.mockDisplayGlasses().copy(hasDisplay = hasDisplay),
        bridgeMode = com.kscan.glasses.bridge.BridgeMode.MOCK,
        sessionId = "session-123",
    )

    private fun defaultCapture() = CaptureResult(
        base64 = "test-base64",
        mimeType = "image/jpeg",
        source = CaptureSource.MOCK,
    )

    private fun successSanitizer() = mockk<PrivacyImageSanitizer> {
        coEvery { sanitize(any(), any()) } returns SanitizeResult.Success("sanitized", "image/jpeg")
    }

    private fun fashionResponse() = FashionAnalyzeResult(
        result = "Structured wool blazer with relaxed silhouette.",
        category = "outerwear",
        color = "charcoal",
        silhouette = "relaxed",
        products = listOf(
            ProductMatch("1", "Relaxed Wool Blazer", "Mock", "$298", null, "https://example.com/1"),
            ProductMatch("2", "Charcoal Jacket", "Mock", "$245", null, "https://example.com/2"),
            ProductMatch("3", "Sport Coat", "Mock", "$189", null, "https://example.com/3"),
            ProductMatch("4", "Extra item", "Mock", "$0", null, null),
        ),
    )

    @Test
    fun `scan cannot start twice while processing`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } coAnswers {
                kotlinx.coroutines.delay(5000)
                defaultCapture()
            }
        }
        val sanitizer = successSanitizer()
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } returns fashionResponse()
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)

        // Coroutine is suspended at delay(5000); isProcessing should still be true
        assertTrue(vm.isProcessing.value)

        // Second scan should be ignored while processing
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)

        // Advance time so the first scan can complete
        advanceUntilIdle()
        assertFalse(vm.isProcessing.value)

        // capturePhoto should only be called once
        coVerify(exactly = 1) { bridge.capturePhoto() }
    }

    @Test
    fun `capture failure shows user-friendly error`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } throws CaptureException("Camera unavailable")
        }
        val vm = createViewModel(bridge = bridge)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        assertEquals(AppScreen.ERROR, vm.screen.value)
        assertTrue(vm.errorMessage.value?.contains("Capture failed") == true)
    }

    @Test
    fun `sanitizer failure blocks backend upload`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } returns defaultCapture()
        }
        val sanitizer = mockk<PrivacyImageSanitizer> {
            coEvery { sanitize(any(), any()) } returns SanitizeResult.Blocked("Face detection failed")
        }
        val analyzeClient = mockk<AnalyzeClient>(relaxed = true)

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        assertEquals(AppScreen.ERROR, vm.screen.value)
        assertTrue(vm.errorMessage.value?.contains("Privacy check blocked") == true)
        coVerify(exactly = 0) { analyzeClient.analyze(any()) }
    }

    @Test
    fun `backend timeout shows user-friendly error`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } returns defaultCapture()
        }
        val sanitizer = successSanitizer()
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } throws com.kscan.glasses.analyze.AnalyzeException.Timeout("Timed out")
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        assertEquals(AppScreen.ERROR, vm.screen.value)
        assertTrue(vm.errorMessage.value?.contains("timed out") == true)
    }

    @Test
    fun `backend non-2xx shows user-friendly error`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } returns defaultCapture()
        }
        val sanitizer = successSanitizer()
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } throws com.kscan.glasses.analyze.AnalyzeException.HttpError(500, "Internal error")
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        assertEquals(AppScreen.ERROR, vm.screen.value)
        assertEquals("Server error (500). Please retry.", vm.errorMessage.value)
    }

    @Test
    fun `malformed backend response shows user-friendly error`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } returns defaultCapture()
        }
        val sanitizer = successSanitizer()
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } throws com.kscan.glasses.analyze.AnalyzeException.MalformedJson("Bad JSON")
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        assertEquals(AppScreen.ERROR, vm.screen.value)
        assertTrue(vm.errorMessage.value?.contains("unreadable") == true)
    }

    @Test
    fun `successful scan renders top 3 results`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } returns defaultCapture()
        }
        val sanitizer = successSanitizer()
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } returns fashionResponse()
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        assertEquals(AppScreen.RESULTS, vm.screen.value)
        assertEquals(3, vm.results.value.topProducts.size)
        assertEquals("Relaxed Wool Blazer", vm.results.value.topProducts[0].name)
        assertEquals("Charcoal Jacket", vm.results.value.topProducts[1].name)
        assertEquals("Sport Coat", vm.results.value.topProducts[2].name)
    }

    @Test
    fun `analyze receives only sanitized validated data URLs never raw capture bytes`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } returns defaultCapture() // base64 = "test-base64"
        }
        val sanitizer = successSanitizer() // returns "sanitized"
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } returns fashionResponse()
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        // The ONLY analyze call carries a data URL built from the sanitizer output,
        // never the raw capture payload.
        coVerify(exactly = 1) {
            analyzeClient.analyze(match { request: AnalyzeRequest ->
                request.imageDataUrl.startsWith("data:image/") &&
                    request.imageDataUrl.contains("sanitized") &&
                    !request.imageDataUrl.contains("test-base64")
            })
        }
    }

    @Test
    fun `save emits SAVE_ITEM bridge message`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } returns defaultCapture()
        }
        val sanitizer = successSanitizer()
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } returns fashionResponse()
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        // Focus should be on first product (index 0)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.VoiceCommand("K Scan save this"))
        advanceUntilIdle()

        coVerify(atLeast = 1) {
            bridge.sendToPhone(match { it.type == BridgeMessageType.SAVE_ITEM.name })
        }
    }

    @Test
    fun `open on phone emits OPEN_ON_PHONE bridge message`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState()
            coEvery { capturePhoto() } returns defaultCapture()
        }
        val sanitizer = successSanitizer()
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } returns fashionResponse()
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        // Navigate to the "Open on Phone" action (index 3: 3 products + 0 = first action item?)
        // Actually products are 0,1,2 and actions are 3,4,5. So we need to go Down 3 times.
        repeat(3) { vm.onInput(com.kscan.glasses.navigation.GlassesInput.Down) }
        advanceUntilIdle()

        vm.onInput(com.kscan.glasses.navigation.GlassesInput.VoiceCommand("K Scan open on phone"))
        advanceUntilIdle()

        coVerify(atLeast = 1) {
            bridge.openOnPhone("https://example.com/1")
        }
    }

    @Test
    fun `audio-only mode speaks summary and does not show results screen`() = runTest {
        val bridge = mockk<GlassesBridgeProvider>(relaxed = true) {
            coEvery { getDeviceState() } returns defaultBridgeState(hasDisplay = false)
            coEvery { capturePhoto() } returns defaultCapture()
        }
        val sanitizer = successSanitizer()
        val analyzeClient = mockk<AnalyzeClient> {
            coEvery { analyze(any()) } returns fashionResponse()
        }

        val vm = createViewModel(bridge = bridge, analyzeClient = analyzeClient, sanitizer = sanitizer)
        vm.onInput(com.kscan.glasses.navigation.GlassesInput.ScanShortcut)
        advanceUntilIdle()

        // In audio-only mode, screen should return to SCAN, not RESULTS
        assertEquals(AppScreen.SCAN, vm.screen.value)
        assertFalse(vm.hasDisplay.value)

        // Speech should still be called with summary
        coVerify(atLeast = 1) {
            bridge.speak(match { it.contains("blazer") || it.contains("Top match") })
        }

        // Result should be sent to phone
        coVerify(atLeast = 1) {
            bridge.sendToPhone(match { it.type == BridgeMessageType.ANALYSIS_RESULT.name })
        }
    }
}
