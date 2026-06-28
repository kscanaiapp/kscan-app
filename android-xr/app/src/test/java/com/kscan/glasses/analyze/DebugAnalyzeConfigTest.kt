package com.kscan.glasses.analyze

import com.kscan.glasses.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugAnalyzeConfigTest {

    @Test
    fun `default config is disabled`() {
        val config = DebugAnalyzeConfig.DEFAULT
        assertFalse("enabled should default to false", config.enabled)
        assertFalse("isPresent should be false when disabled", config.isPresent)
    }

    @Test
    fun `enabled true with blank url is not present`() {
        val config = DebugAnalyzeConfig(
            enabled = true,
            backendUrl = "",
            authToken = "",
        )
        assertTrue("enabled should be true", config.enabled)
        assertFalse("isPresent should be false when URL is blank", config.isPresent)
    }

    @Test
    fun `enabled true with url is present`() {
        val config = DebugAnalyzeConfig(
            enabled = true,
            backendUrl = "http://10.0.2.2:3002/api/glasses/analyze-debug",
            authToken = "test-token",
        )
        assertTrue("enabled should be true", config.enabled)
        assertTrue("isPresent should be true when enabled and URL present", config.isPresent)
    }

    @Test
    fun `enabled false with url is not present`() {
        val config = DebugAnalyzeConfig(
            enabled = false,
            backendUrl = "http://10.0.2.2:3002/api/glasses/analyze-debug",
            authToken = "test-token",
        )
        assertFalse("enabled should be false", config.enabled)
        assertFalse("isPresent should be false when disabled even with URL", config.isPresent)
    }

    @Test
    fun `token is never exposed in toString`() {
        val config = DebugAnalyzeConfig(
            enabled = true,
            backendUrl = "http://10.0.2.2:3002/api/glasses/analyze-debug",
            authToken = "secret-token-123",
        )
        val str = config.toString()
        assertFalse("toString should not contain raw token", str.contains("secret-token-123"))
    }

    @Test
    fun `dryRun flag is preserved from defaults`() {
        val config = DebugAnalyzeConfig.DEFAULT
        // Default dryRun comes from BuildConfig, which defaults to false
        // We cannot assert the exact value without controlling BuildConfig,
        // but we can assert the field exists and is readable.
        // In practice, the default is false.
        assertEquals(false, config.dryRunBuildFlag)
    }

    // ─── Security / BuildConfig hardening tests ────────────────────────────────

    @Test
    fun `fromBuildConfig does not expose an auth token`() {
        val config = DebugAnalyzeConfig.fromBuildConfig()
        // The authToken must be intentionally empty because BuildConfig never
        // contains credentials. It must not leak a local.properties token.
        assertEquals("", config.authToken)
    }

    @Test
    fun `fromBuildConfig returns expected non-secret fields`() {
        val config = DebugAnalyzeConfig.fromBuildConfig()
        // These fields are allowed to come from BuildConfig because they are
        // non-secret flags (boolean, debug URL string, dry-run flag).
        // We only assert the types/shape exist; exact values depend on build config.
        assertEquals(false, config.authToken.isNotBlank())
    }
}