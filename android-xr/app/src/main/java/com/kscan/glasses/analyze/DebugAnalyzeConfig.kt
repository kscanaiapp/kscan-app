package com.kscan.glasses.analyze

import com.kscan.glasses.BuildConfig

/**
 * Debug-only backend analyze configuration.
 *
 * Values are populated from gitignored local Gradle properties (e.g. local.properties)
 * and emitted as blank BuildConfig fields by default. No real URL or token is committed.
 *
 * Token and URL are never logged. [isPresent] only indicates that a non-empty backend URL
 * was supplied locally; it does not enable dry-run unless all [BetaConfig] gates also pass.
 */
data class DebugAnalyzeConfig(
    val enabled: Boolean = BuildConfig.KSCAN_DEBUG_ANALYZE_ENABLED,
    val backendUrl: String = BuildConfig.KSCAN_DEBUG_ANALYZE_URL,
    val authToken: String = BuildConfig.KSCAN_DEBUG_ANALYZE_AUTH_TOKEN,
    val dryRunBuildFlag: Boolean = BuildConfig.KSCAN_DEBUG_ANALYZE_DRY_RUN,
) {
    /**
     * True when debug analyze is explicitly enabled AND a backend URL is present.
     * A blank URL or enabled=false means the real debug client cannot be used.
     */
    val isPresent: Boolean
        get() = enabled && backendUrl.isNotBlank()

    companion object {
        val DEFAULT = DebugAnalyzeConfig()
    }
}
