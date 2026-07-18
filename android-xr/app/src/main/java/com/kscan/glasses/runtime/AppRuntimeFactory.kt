package com.kscan.glasses.runtime

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeClientConfig
import com.kscan.glasses.analyze.AnalyzeClientFactory
import com.kscan.glasses.analyze.DebugAnalyzeConfig
import com.kscan.glasses.analyze.GlassesDebugEndpointClientFactory
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.GoogleBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.mobilebridge.MobileAppBridge
import com.kscan.glasses.mobilebridge.MockMobileAppBridge
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizerFactory
import com.kscan.glasses.privacy.SanitizerMode
import com.kscan.glasses.safety.ReleaseSafetyGuard

/**
 * THE single authoritative composition point for the app's runtime dependencies.
 *
 * KScanApplication, MainActivity, ScanOrchestratorFactory, and release-safety
 * verification must not make independent contradictory decisions: everything is
 * constructed here from one [RuntimeProfile], then cross-verified by
 * [ReleaseSafetyGuard.verifyDependencies] so that flags and injected instances
 * can never disagree silently.
 *
 * Profiles:
 * - Debug mock profile (default): mock bridge, mock sanitizer, mock analyze client;
 *   labeled MOCK in the UI.
 * - Debug strict-privacy profile (KSCAN_DEBUG_USE_MOCK_SANITIZER=false): strict
 *   sanitizer; upload fails closed while face masking is unavailable in this build.
 * - Release: Google bridge stub, strict sanitizer, fail-closed real analyze client.
 *   No mock API, no mock sanitizer, no mock bridge, no silent fallback.
 */
object AppRuntimeFactory {

    data class Resolved(
        val profile: RuntimeProfile,
        val bridge: GlassesBridgeProvider,
        val sanitizer: PrivacyImageSanitizer,
        val analyzeClient: AnalyzeClient,
        val mobileBridge: MobileAppBridge,
        val betaConfig: BetaConfig,
        val clientConfig: AnalyzeClientConfig,
        val debugConfig: DebugAnalyzeConfig,
        val runtimeStatus: RuntimeStatus,
    )

    fun resolve(
        profile: RuntimeProfile = RuntimeProfile.fromBuildConfig(),
        debugConfig: DebugAnalyzeConfig = DebugAnalyzeConfig.fromBuildConfig(),
        betaConfig: BetaConfig = BetaConfig.DEFAULT,
        clientConfig: AnalyzeClientConfig = AnalyzeClientConfig.MOCK_ONLY,
    ): Resolved {
        // 1. Flag-level release guard: throws if any mock flag is set in release.
        ReleaseSafetyGuard.verify(
            isDebugBuild = profile.isDebugBuild,
            useMockApi = profile.useMockApi,
            useMockSanitizer = profile.useMockSanitizer,
            useMockBridge = profile.useMockBridge,
        )

        // 2. Bridge: mock only when the profile permits it (debug mock profile).
        val bridge: GlassesBridgeProvider = if (profile.useMockBridge) {
            MockBridgeProvider()
        } else {
            GoogleBridgeProvider()
        }

        // 3. Sanitizer: ONE authoritative construction point.
        val sanitizer = PrivacyImageSanitizerFactory.create(
            mode = if (profile.useMockSanitizer) SanitizerMode.MOCK else SanitizerMode.PRODUCTION,
            isDebugBuild = profile.isDebugBuild,
        )

        // 4. Analyze client. The BuildConfig profile is authoritative for mock
        // selection; BetaConfig carries the real-feature opt-ins.
        val effectiveBeta = betaConfig.copy(useMockApi = profile.useMockApi)
        val analyzeClient: AnalyzeClient = when {
            // Debug-only: local debug endpoint smoke path (requires local.properties config).
            profile.isDebugBuild && debugConfig.isPresent && !debugConfig.dryRunBuildFlag ->
                GlassesDebugEndpointClientFactory.create(
                    betaConfig = effectiveBeta.copy(
                        enableRealAnalyze = true,
                        enableRealFaceMasking = true,
                    ),
                    debugConfig = debugConfig,
                )
            else ->
                AnalyzeClientFactory.create(
                    betaConfig = effectiveBeta,
                    clientConfig = clientConfig,
                    isDebugBuild = profile.isDebugBuild,
                )
        }

        // Phone-handoff bridge remains an in-memory placeholder in every profile;
        // no real transport exists yet and no scan result can exist without analyze.
        val mobileBridge: MobileAppBridge = MockMobileAppBridge()

        // 5. Instance-level verification: fail fast when configuration and the
        // injected dependency instances disagree. Never convert a release
        // misconfiguration into a mock result.
        ReleaseSafetyGuard.verifyDependencies(
            bridge = bridge,
            sanitizer = sanitizer,
            analyzeClient = analyzeClient,
            isDebugBuild = profile.isDebugBuild,
            useMockApi = profile.useMockApi,
            useMockSanitizer = profile.useMockSanitizer,
            useMockBridge = profile.useMockBridge,
        )

        // 6. Explicit runtime state for the UI, derived from resolved instances.
        val runtimeStatus = RuntimeStatus(
            state = RuntimeStateResolver.resolve(
                bridge = bridge,
                sanitizer = sanitizer,
                analyzeClient = analyzeClient,
                isDebugBuild = profile.isDebugBuild,
                dryRunConfigured = effectiveBeta.enableDryRun && debugConfig.isPresent,
            ),
            mock = RuntimeStateResolver.isMockRuntime(bridge, sanitizer, analyzeClient),
        )

        return Resolved(
            profile = profile,
            bridge = bridge,
            sanitizer = sanitizer,
            analyzeClient = analyzeClient,
            mobileBridge = mobileBridge,
            betaConfig = effectiveBeta,
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            runtimeStatus = runtimeStatus,
        )
    }
}
