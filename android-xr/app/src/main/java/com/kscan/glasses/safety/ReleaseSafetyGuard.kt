package com.kscan.glasses.safety

import com.kscan.glasses.BuildConfig

/**
 * Runtime safety guard for release builds.
 *
 * Must be called early in application startup (e.g. KScanApplication.onCreate).
 * Throws IllegalStateException if the build is configured with unsafe mock settings
 * in a release configuration.
 */
object ReleaseSafetyGuard {

    fun verify() {
        if (BuildConfig.DEBUG) {
            // Debug builds may use mock infrastructure for local development.
            return
        }

        // Release builds must never use mock sanitizer.
        if (BuildConfig.USE_MOCK_SANITIZER) {
            throw IllegalStateException(
                "CRITICAL: Release build configured with USE_MOCK_SANITIZER=true. " +
                "Mock sanitizer does not provide production privacy. " +
                "Remove mock sanitizer before release."
            )
        }

        // Release builds must never use mock bridge unless explicitly intended for internal testing.
        // This is a warning-level check; bridge mock is less critical than privacy mock.
        if (BuildConfig.USE_MOCK_BRIDGE) {
            throw IllegalStateException(
                "CRITICAL: Release build configured with USE_MOCK_BRIDGE=true. " +
                "Mock bridge is not intended for production release."
            )
        }
    }
}
