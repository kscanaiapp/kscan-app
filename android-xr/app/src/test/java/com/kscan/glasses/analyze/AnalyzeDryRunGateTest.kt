package com.kscan.glasses.analyze

import com.kscan.glasses.config.BetaConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyzeDryRunGateTest {

    private val readyConfig = BetaConfig(
        useMockApi = false,
        enableRealAnalyze = true,
        enableRealFaceMasking = true,
        enableDryRun = true,
    )

    private val clientConfig = AnalyzeClientConfig(
        backendUrl = "https://example.com",
        enableRealAnalyze = false,
    )

    private val debugConfig = DebugAnalyzeConfig(
        enabled = true,
        backendUrl = "https://example.com",
        authToken = "",
        dryRunBuildFlag = true,
    )

    @Test
    fun `all gates true returns Ready`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig,
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.Ready)
    }

    @Test
    fun `release build blocks dry-run`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig,
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            sanitizerSuccess = true,
            isDebugBuild = false,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("release_build", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `useMockApi true blocks dry-run`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig.copy(useMockApi = true),
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("useMockApi", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `enableRealAnalyze false blocks dry-run`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig.copy(enableRealAnalyze = false),
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("enableRealAnalyze", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `enableRealFaceMasking false blocks dry-run`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig.copy(enableRealFaceMasking = false),
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("enableRealFaceMasking", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `enableDryRun false blocks dry-run`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig.copy(enableDryRun = false),
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("enableDryRun", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `blank backendUrl blocks dry-run`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig,
            clientConfig = clientConfig.copy(backendUrl = ""),
            debugConfig = debugConfig,
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("backend_url_missing", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `missing debug backend config blocks dry-run`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig,
            clientConfig = clientConfig,
            debugConfig = DebugAnalyzeConfig(backendUrl = ""),
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("debug_backend_config_missing", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `sanitizer failure blocks dry-run`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig,
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            sanitizerSuccess = false,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.Blocked)
        assertEquals("sanitizer_failed", (result as DryRunGateResult.Blocked).gate)
    }

    @Test
    fun `default BetaConfig is not dry-run ready`() = runTest {
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = BetaConfig.DEFAULT,
            clientConfig = AnalyzeClientConfig.MOCK_ONLY,
            debugConfig = DebugAnalyzeConfig.DEFAULT,
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
    }

    @Test
    fun `debug analyze explicitly disabled blocks dry-run`() = runTest {
        // Backend URL is present but debug analyze is explicitly turned off:
        // isPresent requires BOTH, so this must fail the same gate.
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig,
            clientConfig = clientConfig,
            debugConfig = debugConfig.copy(enabled = false),
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("debug_backend_config_missing", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `safety guard rejection blocks dry-run`() = runTest {
        // Passes every earlier gate, but enableRealConnectivity=true is rejected
        // by BetaSafetyGuard (no transport support exists in this phase).
        val result = AnalyzeDryRunGate.evaluate(
            betaConfig = readyConfig.copy(enableRealConnectivity = true),
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            sanitizerSuccess = true,
            isDebugBuild = true,
        )
        assertTrue(result is DryRunGateResult.ConfigBlocked)
        assertEquals("safety_guard", (result as DryRunGateResult.ConfigBlocked).gate)
    }

    @Test
    fun `gate results never expose urls tokens or payload material`() = runTest {
        val sensitiveDebug = DebugAnalyzeConfig(
            enabled = false,
            backendUrl = "https://internal.example.com:8787/private",
            authToken = "super-secret-token",
            dryRunBuildFlag = true,
        )
        val outcomes = listOf(
            AnalyzeDryRunGate.evaluate(readyConfig.copy(useMockApi = true), clientConfig, sensitiveDebug, true, isDebugBuild = true),
            AnalyzeDryRunGate.evaluate(readyConfig, clientConfig.copy(backendUrl = ""), sensitiveDebug, true, isDebugBuild = true),
            AnalyzeDryRunGate.evaluate(readyConfig, clientConfig, sensitiveDebug, true, isDebugBuild = true),
            AnalyzeDryRunGate.evaluate(readyConfig, clientConfig, debugConfig, false, isDebugBuild = true),
            AnalyzeDryRunGate.evaluate(readyConfig, clientConfig, sensitiveDebug, true, isDebugBuild = false),
        )
        for (outcome in outcomes) {
            val text = outcome.toString()
            assertTrue(!text.contains("super-secret-token"))
            assertTrue(!text.contains("internal.example.com"))
            assertTrue(!text.contains("http"))
            assertTrue(!text.contains("base64"))
        }
    }
}
