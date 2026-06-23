package com.kscan.glasses.config

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BetaConfigTest {

    @Test
    fun `safe default config passes`() {
        val config = BetaConfig.DEFAULT
        assertTrue(BetaSafetyGuard.isSafeDebugConfig(config))
    }

    @Test(expected = IllegalStateException::class)
    fun `unsafe real analyze blocked`() {
        val config = BetaConfig(enableRealAnalyze = true)
        BetaSafetyGuard.validate(config)
    }

    @Test(expected = IllegalStateException::class)
    fun `unsafe real connectivity blocked`() {
        val config = BetaConfig(enableRealConnectivity = true)
        BetaSafetyGuard.validate(config)
    }

    @Test
    fun `mock-safe debug config allowed`() {
        val config = BetaConfig(
            useMockBridge = true,
            useMockApi = true,
            useMockSupabase = true,
            enableRealAnalyze = false,
            enableRealConnectivity = false,
            enableRealVoice = false,
            enableRealCamera = false,
            enableRealFaceMasking = false,
            enableDryRun = false,
        )
        assertTrue(BetaSafetyGuard.isSafeDebugConfig(config))
    }

    @Test
    fun `enableDryRun defaults to false`() {
        assertFalse(BetaConfig.DEFAULT.enableDryRun)
    }

    @Test
    fun `real analyze preparation permitted only in debug`() {
        val safeRealConfig = BetaConfig(
            useMockApi = false,
            enableRealAnalyze = true,
            enableRealFaceMasking = true,
            enableDryRun = true,
        )
        assertTrue(BetaSafetyGuard.permitsRealAnalyzePreparation(safeRealConfig, isDebugBuild = true))
        assertFalse(BetaSafetyGuard.permitsRealAnalyzePreparation(safeRealConfig, isDebugBuild = false))
    }

    @Test
    fun `real analyze preparation denied when config is unsafe`() {
        val unsafeConfig = BetaConfig(enableRealAnalyze = true)
        assertFalse(BetaSafetyGuard.permitsRealAnalyzePreparation(unsafeConfig, isDebugBuild = true))
    }

    @Test
    fun `SafeLog rejects payload-like messages`() {
        assertTrue(SafeLog.rejectPayloadLog("base64 string here"))
        assertTrue(SafeLog.rejectPayloadLog("data:image/png;base64"))
        assertTrue(SafeLog.rejectPayloadLog("token value"))
        assertFalse(SafeLog.rejectPayloadLog("Analysis started"))
        assertFalse(SafeLog.rejectPayloadLog("Capture completed"))
    }
}
