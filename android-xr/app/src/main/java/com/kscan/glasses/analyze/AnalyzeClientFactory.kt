package com.kscan.glasses.analyze

import com.kscan.glasses.BuildConfig
import com.kscan.glasses.config.BetaConfig

/**
 * Factory for creating [AnalyzeClient] with controlled backend boundary.
 *
 * Debug builds — all gates must be true to create an enabled [RealAnalyzeClient]:
 * 1. [BetaConfig.useMockApi] == false (mock lock — must be explicitly false)
 * 2. [BetaConfig.enableRealAnalyze] == true (explicit opt-in)
 * 3. [BetaConfig.enableRealFaceMasking] == true (privacy gate)
 * 4. [AnalyzeClientConfig.backendUrl] is non-empty
 *
 * If any debug gate is false, returns [MockAnalyzeClient] (safe, UI-labeled default).
 *
 * Release builds NEVER return a mock and NEVER silently fall back:
 * - [BetaConfig.useMockApi] == true in release -> throws IllegalStateException.
 * - Otherwise returns a fail-closed [RealAnalyzeClient] with real analyze disabled;
 *   live analysis is not authorized in this build, so any analyze() call throws
 *   [AnalyzeException.Disabled] instead of producing a synthetic result.
 */
object AnalyzeClientFactory {

    fun create(
        betaConfig: BetaConfig,
        clientConfig: AnalyzeClientConfig,
        isDebugBuild: Boolean = BuildConfig.DEBUG,
    ): AnalyzeClient {
        if (betaConfig.useMockApi) {
            if (!isDebugBuild) {
                throw IllegalStateException(
                    "CRITICAL: Mock analyze client requested in a release build " +
                    "(useMockApi=true). Release builds must never use mock analyze " +
                    "and must never silently fall back to mock."
                )
            }
            return MockAnalyzeClient()
        }
        if (!isDebugBuild) {
            // Release: live analysis is NOT authorized in this build.
            // Fail closed with an explicitly disabled real client — never a mock.
            return RealAnalyzeClient(
                config = clientConfig.copy(enableRealAnalyze = false),
                transport = KscanHttpTransport(),
                betaConfig = betaConfig.copy(enableRealAnalyze = false),
            )
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
