package com.kscan.glasses.runtime

import com.kscan.glasses.BuildConfig
import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.MockAnalyzeClient
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.StrictPrivacyImageSanitizer

/**
 * Explicit runtime state for the glasses app.
 *
 * The UI must derive its persistent status from this single model instead of
 * inferring status from loosely related flags scattered across BuildConfig,
 * BetaConfig, and individual component types.
 */
enum class GlassesRuntimeState {
    /** Debug build running on mock infrastructure. Allowed, but always labeled MOCK. */
    MOCK_DEVELOPMENT,

    /** Configuration is incomplete or inconsistent; setup is required before scanning. */
    CONFIGURATION_REQUIRED,

    /** Strict privacy mode selected but masking is unavailable; uploads are blocked. */
    PRIVACY_BLOCKED,

    /** All dry-run gates pass; real analyze readiness proven without transport execution. */
    DRY_RUN_READY,

    /**
     * Live analysis authorized. UNREACHABLE in this build: no build profile may
     * authorize live analysis yet. RuntimeStateResolver never returns this value.
     */
    LIVE_ANALYSIS_AUTHORIZED,
}

/**
 * Immutable UI-facing runtime status: the resolved state plus whether any mock
 * component is present in the active pipeline.
 */
data class RuntimeStatus(
    val state: GlassesRuntimeState,
    val mock: Boolean,
)

/**
 * Build-time mock profile resolved once from BuildConfig flags.
 * This is the single source of truth for which infrastructure profile is active.
 */
data class RuntimeProfile(
    val isDebugBuild: Boolean,
    val useMockBridge: Boolean,
    val useMockApi: Boolean,
    val useMockSanitizer: Boolean,
    val useMockPhoneBridge: Boolean,
) {
    val anyMock: Boolean
        get() = useMockBridge || useMockApi || useMockSanitizer || useMockPhoneBridge

    companion object {
        fun fromBuildConfig(): RuntimeProfile = RuntimeProfile(
            isDebugBuild = BuildConfig.DEBUG,
            useMockBridge = BuildConfig.USE_MOCK_BRIDGE,
            useMockApi = BuildConfig.USE_MOCK_API,
            useMockSanitizer = BuildConfig.USE_MOCK_SANITIZER,
            useMockPhoneBridge = BuildConfig.KSCAN_DEBUG_MOCK_PHONE_BRIDGE,
        )
    }
}

/**
 * Resolves the authoritative [GlassesRuntimeState] from the actual injected
 * dependency instances (not just flags).
 *
 * Resolution order:
 * 1. Any mock instance present -> [GlassesRuntimeState.MOCK_DEVELOPMENT]
 *    (release builds never reach this: ReleaseSafetyGuard throws first;
 *    a defensive [GlassesRuntimeState.CONFIGURATION_REQUIRED] is returned if they do).
 * 2. Strict sanitizer without available face masking -> [GlassesRuntimeState.PRIVACY_BLOCKED].
 * 3. All strict instances + dry-run configured in debug -> [GlassesRuntimeState.DRY_RUN_READY].
 * 4. Otherwise -> [GlassesRuntimeState.CONFIGURATION_REQUIRED].
 *
 * [GlassesRuntimeState.LIVE_ANALYSIS_AUTHORIZED] is intentionally never returned.
 */
object RuntimeStateResolver {

    fun isMockRuntime(
        bridge: GlassesBridgeProvider,
        sanitizer: PrivacyImageSanitizer,
        analyzeClient: AnalyzeClient,
    ): Boolean =
        bridge is MockBridgeProvider ||
            sanitizer is MockPrivacyImageSanitizer ||
            analyzeClient is MockAnalyzeClient

    fun resolve(
        bridge: GlassesBridgeProvider,
        sanitizer: PrivacyImageSanitizer,
        analyzeClient: AnalyzeClient,
        isDebugBuild: Boolean,
        dryRunConfigured: Boolean = false,
    ): GlassesRuntimeState {
        return resolve(
            mock = isMockRuntime(bridge, sanitizer, analyzeClient),
            maskingAvailable = (sanitizer as? StrictPrivacyImageSanitizer)?.isMaskingAvailable == true,
            isDebugBuild = isDebugBuild,
            dryRunConfigured = dryRunConfigured,
        )
    }

    fun resolve(
        mock: Boolean,
        maskingAvailable: Boolean,
        isDebugBuild: Boolean,
        dryRunConfigured: Boolean = false,
    ): GlassesRuntimeState {
        if (mock) {
            return if (isDebugBuild) {
                GlassesRuntimeState.MOCK_DEVELOPMENT
            } else {
                // Unreachable: ReleaseSafetyGuard.verifyDependencies throws on mock
                // instances in release before this resolver is ever called.
                GlassesRuntimeState.CONFIGURATION_REQUIRED
            }
        }

        if (!maskingAvailable) {
            return GlassesRuntimeState.PRIVACY_BLOCKED
        }

        if (dryRunConfigured && isDebugBuild) {
            return GlassesRuntimeState.DRY_RUN_READY
        }

        return GlassesRuntimeState.CONFIGURATION_REQUIRED
        // LIVE_ANALYSIS_AUTHORIZED is not returned by any path in this build.
    }
}
