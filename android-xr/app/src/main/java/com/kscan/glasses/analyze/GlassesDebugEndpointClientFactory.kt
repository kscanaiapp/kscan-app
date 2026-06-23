package com.kscan.glasses.analyze

import com.kscan.glasses.config.BetaConfig

/**
 * Factory for creating the glasses debug endpoint client.
 *
 * This is strictly for local debug smoke testing.
 * It is never created in release builds and defaults to [MockAnalyzeClient].
 *
 * Gates:
 * 1. [BetaConfig.enableRealAnalyze] == true
 * 2. [BetaConfig.enableRealFaceMasking] == true
 * 3. [DebugAnalyzeConfig.enabled] == true
 * 4. [DebugAnalyzeConfig.backendUrl] is non-empty
 * 5. [DebugAnalyzeConfig.authToken] is non-empty (if backend requires token)
 *
 * If any gate is false, returns [MockAnalyzeClient] (safe default).
 */
object GlassesDebugEndpointClientFactory {

    fun create(
        betaConfig: BetaConfig,
        debugConfig: DebugAnalyzeConfig,
    ): AnalyzeClient {
        if (!betaConfig.enableRealAnalyze) {
            return MockAnalyzeClient()
        }
        if (!betaConfig.enableRealFaceMasking) {
            return MockAnalyzeClient()
        }
        if (!debugConfig.enabled) {
            return MockAnalyzeClient()
        }
        if (debugConfig.backendUrl.isBlank()) {
            return MockAnalyzeClient()
        }
        return GlassesDebugEndpointClient(
            endpointUrl = debugConfig.backendUrl,
            authToken = debugConfig.authToken,
            transport = KscanHttpTransport(),
        )
    }
}
