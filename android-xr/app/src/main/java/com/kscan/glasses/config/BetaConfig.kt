package com.kscan.glasses.config

/**
 * Single source of truth for safe beta configuration defaults.
 *
 * All real paths are disabled by default. No live backend, no real hardware,
 * no real voice, no real camera, no real connectivity without explicit opt-in.
 */
data class BetaConfig(
    val useMockBridge: Boolean = true,
    val useMockApi: Boolean = true,
    val useMockSupabase: Boolean = true,
    val enableRealAnalyze: Boolean = false,
    val enableRealConnectivity: Boolean = false,
    val enableRealVoice: Boolean = false,
    val enableRealCamera: Boolean = false,
    val enableRealFaceMasking: Boolean = false,
) {
    companion object {
        val DEFAULT = BetaConfig()
    }
}
