package com.kscan.glasses.analyze

/**
 * Analyze client configuration.
 *
 * All real paths are disabled by default. Explicit opt-in required.
 */
data class AnalyzeClientConfig(
    val backendUrl: String = "",
    val timeoutMs: Int = 10_000,
    val enableRealAnalyze: Boolean = false,
) {
    init {
        if (enableRealAnalyze) {
            require(backendUrl.isNotBlank()) {
                "backendUrl is required when enableRealAnalyze=true"
            }
        }
    }

    companion object {
        val MOCK_ONLY = AnalyzeClientConfig(
            backendUrl = "",
            enableRealAnalyze = false,
        )
    }
}
