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
 *
 * SECURITY: Do not place credentials, tokens, or secrets in BuildConfig. BuildConfig values are
 * compiled into the APK and can be extracted by anyone who has the APK. Future live debug auth
 * must use a separate runtime-only credential provider.
 */
data class DebugAnalyzeConfig(
    val enabled: Boolean = false,
    val backendUrl: String = "",
    val authToken: String = "",
    val dryRunBuildFlag: Boolean = false,
) {
    /**
     * True when debug analyze is explicitly enabled AND a backend URL is present.
     * A blank URL or enabled=false means the real debug client cannot be used.
     */
    val isPresent: Boolean
        get() = enabled && backendUrl.isNotBlank()

    override fun toString(): String =
        "DebugAnalyzeConfig(enabled=$enabled, backendUrl=$backendUrl, authToken=[REDACTED], dryRunBuildFlag=$dryRunBuildFlag)"

    companion object {
        val DEFAULT = DebugAnalyzeConfig()

        fun fromBuildConfig(): DebugAnalyzeConfig = DebugAnalyzeConfig(
            enabled = BuildConfig.KSCAN_DEBUG_ANALYZE_ENABLED,
            backendUrl = BuildConfig.KSCAN_DEBUG_ANALYZE_URL,
            // SECURITY: Do not read credentials from BuildConfig. BuildConfig values are compiled
            // into the APK and can be extracted. Future live debug auth must use a runtime-only
            // credential provider. For now, authToken is always empty in BuildConfig-derived config.
            authToken = "",
            dryRunBuildFlag = BuildConfig.KSCAN_DEBUG_ANALYZE_DRY_RUN,
        )
    }
}
