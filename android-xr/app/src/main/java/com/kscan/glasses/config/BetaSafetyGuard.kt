package com.kscan.glasses.config

import com.kscan.glasses.BuildConfig
import com.kscan.glasses.safety.ReleaseSafetyGuard

/**
 * Beta safety guard — validates config combinations and fails fast on unsafe setups.
 *
 * Integrates with existing ReleaseSafetyGuard to prevent mock providers in release.
 */
object BetaSafetyGuard {

    fun validate(config: BetaConfig) {
        // Unsafe: real analyze without real face masking (unless explicitly documented as test-only)
        if (config.enableRealAnalyze && !config.enableRealFaceMasking) {
            throw IllegalStateException(
                "Unsafe config: enableRealAnalyze=true with enableRealFaceMasking=false. " +
                "Real user upload is blocked. Enable face masking or disable real analyze."
            )
        }

        // Unsafe: real connectivity without transport support
        if (config.enableRealConnectivity) {
            throw IllegalStateException(
                "Unsafe config: enableRealConnectivity=true without transport support. " +
                "No BLE or Wi-Fi transport is implemented in Phase 2."
            )
        }

        // Release builds must not use mock providers
        ReleaseSafetyGuard.verify()
    }

    fun isSafeDebugConfig(config: BetaConfig): Boolean {
        return try {
            validate(config)
            true
        } catch (_: IllegalStateException) {
            false
        }
    }

    /**
     * Returns true only when the current build is a debug build and the config combination
     * is considered safe for debug-only real analyze *preparation* (dry-run wiring).
     *
     * This does NOT override sanitizer failure and does NOT permit live network execution.
     */
    fun permitsRealAnalyzePreparation(
        config: BetaConfig,
        isDebugBuild: Boolean = BuildConfig.DEBUG,
    ): Boolean {
        return isDebugBuild && isSafeDebugConfig(config)
    }
}
