package com.kscan.glasses.runtime

import com.kscan.glasses.analyze.MockAnalyzeClient
import com.kscan.glasses.bridge.GoogleBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.StrictPrivacyImageSanitizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppRuntimeFactoryTest {

    private val debugMockProfile = RuntimeProfile(
        isDebugBuild = true,
        useMockBridge = true,
        useMockApi = true,
        useMockSanitizer = true,
    )

    private val debugStrictPrivacyProfile = RuntimeProfile(
        isDebugBuild = true,
        useMockBridge = true,
        useMockApi = true,
        useMockSanitizer = false,
    )

    private val releaseProfile = RuntimeProfile(
        isDebugBuild = false,
        useMockBridge = false,
        useMockApi = false,
        useMockSanitizer = false,
    )

    @Test
    fun `debug mock profile resolves mock pipeline labeled MOCK_DEVELOPMENT`() {
        val resolved = AppRuntimeFactory.resolve(profile = debugMockProfile)

        assertTrue(resolved.bridge is MockBridgeProvider)
        assertTrue(resolved.sanitizer is MockPrivacyImageSanitizer)
        assertTrue(resolved.analyzeClient is MockAnalyzeClient)
        assertEquals(GlassesRuntimeState.MOCK_DEVELOPMENT, resolved.runtimeStatus.state)
        assertTrue(resolved.runtimeStatus.mock)
    }

    @Test
    fun `debug strict-privacy profile resolves strict sanitizer`() {
        val resolved = AppRuntimeFactory.resolve(profile = debugStrictPrivacyProfile)

        assertTrue(resolved.sanitizer is StrictPrivacyImageSanitizer)
        // Bridge and analyze client remain mock-permitted in this profile.
        assertTrue(resolved.bridge is MockBridgeProvider)
        assertTrue(resolved.analyzeClient is MockAnalyzeClient)
        // The strict sanitizer cannot mask in this build.
        assertFalse((resolved.sanitizer as StrictPrivacyImageSanitizer).isMaskingAvailable)
    }

    @Test
    fun `release profile resolves no mock instances`() {
        val resolved = AppRuntimeFactory.resolve(profile = releaseProfile)

        assertTrue(resolved.bridge is GoogleBridgeProvider)
        assertTrue(resolved.sanitizer is StrictPrivacyImageSanitizer)
        assertFalse(resolved.analyzeClient is MockAnalyzeClient)
        assertFalse(resolved.runtimeStatus.mock)
        // Strict sanitizer without face masking -> privacy blocked, never "ready".
        assertEquals(GlassesRuntimeState.PRIVACY_BLOCKED, resolved.runtimeStatus.state)
    }

    @Test(expected = IllegalStateException::class)
    fun `release profile with mock API flag throws instead of falling back`() {
        AppRuntimeFactory.resolve(profile = releaseProfile.copy(useMockApi = true))
    }

    @Test(expected = IllegalStateException::class)
    fun `release profile with mock sanitizer flag throws instead of falling back`() {
        AppRuntimeFactory.resolve(profile = releaseProfile.copy(useMockSanitizer = true))
    }

    @Test(expected = IllegalStateException::class)
    fun `release profile with mock bridge flag throws instead of falling back`() {
        AppRuntimeFactory.resolve(profile = releaseProfile.copy(useMockBridge = true))
    }
}
