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
    val backendUrl: String = BuildConfig.KSCAN_DEBUG_ANALYZE_URL,
    val authToken: String = BuildConfig.KSCAN_DEBUG_ANALYZE_AUTH_TOKEN,
    val dryRunBuildFlag: Boolean = BuildConfig.KSCAN_DEBUG_ANALYZE_DRY_RUN,
) {
    /**
     * True when a backend URL was explicitly supplied in the local debug config.
     * A blank URL means dry-run cannot become ready.
     */
    val isPresent: Boolean
        get() = backendUrl.isNotBlank()

    companion object {
        val DEFAULT = DebugAnalyzeConfig()
    }
}
