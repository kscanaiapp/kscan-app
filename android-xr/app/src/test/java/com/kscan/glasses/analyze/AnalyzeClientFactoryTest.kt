package com.kscan.glasses.analyze

import com.kscan.glasses.config.BetaConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyzeClientFactoryTest {

    @Test
    fun `default config returns MockAnalyzeClient`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig.DEFAULT,
            clientConfig = AnalyzeClientConfig.MOCK_ONLY,
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `useMockApi true blocks real analyze`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = true,
                enableRealAnalyze = true,
                enableRealFaceMasking = true,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `enableRealAnalyze false blocks real analyze`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = false,
                enableRealAnalyze = false,
                enableRealFaceMasking = true,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `enableRealFaceMasking false blocks real analyze`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = false,
                enableRealAnalyze = true,
                enableRealFaceMasking = false,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `blank backendUrl blocks real analyze`() = runTest {
        val client = try {
            AnalyzeClientFactory.create(
                betaConfig = BetaConfig(
                    useMockApi = false,
                    enableRealAnalyze = true,
                    enableRealFaceMasking = true,
                ),
                clientConfig = AnalyzeClientConfig(
                    backendUrl = "",
                    enableRealAnalyze = true,
                ),
            )
        } catch (e: IllegalArgumentException) {
            // AnalyzeClientConfig itself rejects blank backendUrl when enableRealAnalyze=true
            // This is acceptable — the config object is a boundary guard
            return@runTest
        }
        // If we reach here, factory should still return MockAnalyzeClient
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `all gates true returns RealAnalyzeClient in debug only`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = false,
                enableRealAnalyze = true,
                enableRealFaceMasking = true,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
        )
        if (com.kscan.glasses.BuildConfig.DEBUG) {
            assertTrue(client is RealAnalyzeClient)
        } else {
            // Release builds always return MockAnalyzeClient regardless of gates
            assertTrue(client is MockAnalyzeClient)
        }
    }
}
