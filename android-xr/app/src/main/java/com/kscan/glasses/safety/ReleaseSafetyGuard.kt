package com.kscan.glasses.safety

import com.kscan.glasses.BuildConfig
import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.MockAnalyzeClient
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizer

/**
 * Runtime safety guard for release builds.
 *
 * Must be called early in application startup (e.g. KScanApplication.onCreate).
 * Throws IllegalStateException if the build is configured with unsafe mock settings
 * in a release configuration.
 *
 * Two layers:
 * - [verify]: flag-level check of all three mock BuildConfig flags.
 * - [verifyDependencies]: instance-level check that the actually injected
 *   bridge / sanitizer / analyze client agree with those flags. Fails fast when
 *   configuration and injected dependencies disagree — a release misconfiguration
 *   must never be converted into a mock result.
 */
object ReleaseSafetyGuard {

    fun verify(
        isDebugBuild: Boolean = BuildConfig.DEBUG,
        useMockApi: Boolean = BuildConfig.USE_MOCK_API,
        useMockSanitizer: Boolean = BuildConfig.USE_MOCK_SANITIZER,
        useMockBridge: Boolean = BuildConfig.USE_MOCK_BRIDGE,
    ) {
        if (isDebugBuild) {
            // Debug builds may use mock infrastructure for local development.
            return
        }

        // Release builds must never use mock API.
        if (useMockApi) {
            throw IllegalStateException(
                "CRITICAL: Release build configured with USE_MOCK_API=true. " +
                "Mock analyze client must never ship in a release build. " +
                "Set USE_MOCK_API=false before release."
            )
        }

        // Release builds must never use mock sanitizer.
        if (useMockSanitizer) {
            throw IllegalStateException(
                "CRITICAL: Release build configured with USE_MOCK_SANITIZER=true. " +
                "Mock sanitizer does not provide production privacy. " +
                "Remove mock sanitizer before release."
            )
        }

        // Release builds must never use mock bridge.
        if (useMockBridge) {
            throw IllegalStateException(
                "CRITICAL: Release build configured with USE_MOCK_BRIDGE=true. " +
                "Mock bridge is not intended for production release."
            )
        }
    }

    /**
     * Verifies that the actually resolved dependency INSTANCES agree with the
     * build configuration. Throws IllegalStateException on any disagreement:
     *
     * - Release build with any mock instance injected -> throw (no silent fallback).
     * - Flag says strict (useMockX=false) but a mock instance was injected -> throw.
     *
     * Debug builds may combine mock instances with mock-permitting flags; those
     * combinations are allowed and are labeled MOCK in the UI.
     */
    fun verifyDependencies(
        bridge: GlassesBridgeProvider,
        sanitizer: PrivacyImageSanitizer,
        analyzeClient: AnalyzeClient,
        isDebugBuild: Boolean = BuildConfig.DEBUG,
        useMockApi: Boolean = BuildConfig.USE_MOCK_API,
        useMockSanitizer: Boolean = BuildConfig.USE_MOCK_SANITIZER,
        useMockBridge: Boolean = BuildConfig.USE_MOCK_BRIDGE,
    ) {
        if (!isDebugBuild) {
            if (analyzeClient is MockAnalyzeClient) {
                throw IllegalStateException(
                    "CRITICAL: Release build resolved a MockAnalyzeClient instance. " +
                    "Release must never fall back to mock analyze."
                )
            }
            if (sanitizer is MockPrivacyImageSanitizer) {
                throw IllegalStateException(
                    "CRITICAL: Release build resolved a MockPrivacyImageSanitizer instance. " +
                    "Release must never fall back to mock sanitization."
                )
            }
            if (bridge is MockBridgeProvider) {
                throw IllegalStateException(
                    "CRITICAL: Release build resolved a MockBridgeProvider instance. " +
                    "Release must never fall back to mock bridge."
                )
            }
        }

        // Flag/instance disagreement (any build type): flag claims strict while
        // the injected instance is mock. This is a wiring bug; fail fast.
        if (!useMockApi && analyzeClient is MockAnalyzeClient) {
            throw IllegalStateException(
                "Configuration mismatch: USE_MOCK_API=false but MockAnalyzeClient was injected. " +
                "Fix the wiring; do not silently downgrade to mock."
            )
        }
        if (!useMockSanitizer && sanitizer is MockPrivacyImageSanitizer) {
            throw IllegalStateException(
                "Configuration mismatch: USE_MOCK_SANITIZER=false but MockPrivacyImageSanitizer was injected. " +
                "Fix the wiring; do not silently downgrade to mock."
            )
        }
        if (!useMockBridge && bridge is MockBridgeProvider) {
            throw IllegalStateException(
                "Configuration mismatch: USE_MOCK_BRIDGE=false but MockBridgeProvider was injected. " +
                "Fix the wiring; do not silently downgrade to mock."
            )
        }
    }
}
