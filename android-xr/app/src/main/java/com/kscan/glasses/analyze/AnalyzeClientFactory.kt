package com.kscan.glasses.analyze

import com.kscan.glasses.BuildConfig
import com.kscan.glasses.config.BetaConfig

/**
 * Factory for creating [AnalyzeClient] with controlled backend boundary.
 *
 * All gates must be true to create a [RealAnalyzeClient]:
 * 1. [BuildConfig.DEBUG] == true (debug builds only)
 * 2. [BetaConfig.enableRealAnalyze] == true (explicit opt-in)
 * 3. [BetaConfig.enableRealFaceMasking] == true (privacy gate)
 * 4. [AnalyzeClientConfig.backendUrl] is non-empty
 *
 * If any gate is false, returns [MockAnalyzeClient] (safe default).
 */
object AnalyzeClientFactory {

    fun create(
        betaConfig: BetaConfig,
        clientConfig: AnalyzeClientConfig,
    ): AnalyzeClient {
        if (!BuildConfig.DEBUG) {
            return MockAnalyzeClient()
        }
        if (!betaConfig.enableRealAnalyze || !betaConfig.enableRealFaceMasking) {
            return MockAnalyzeClient()
        }
        if (clientConfig.backendUrl.isBlank()) {
            return MockAnalyzeClient()
        }
        return RealAnalyzeClient(
            config = clientConfig,
            transport = KscanHttpTransport(),
            betaConfig = betaConfig,
        )
    }
}
