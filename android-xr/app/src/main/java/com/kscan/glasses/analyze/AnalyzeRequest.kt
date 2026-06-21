package com.kscan.glasses.analyze

/**
 * Analyze request payload.
 *
 * image must be a valid data URL: data:image/jpeg;base64,...
 * No raw bytes, no bare base64 strings.
 */
data class AnalyzeRequest(
    val imageDataUrl: String,
) {
    init {
        require(imageDataUrl.startsWith("data:image/")) {
            "AnalyzeRequest.imageDataUrl must be a valid data:image/* URL"
        }
    }

    companion object {
        fun isValidDataUrl(url: String): Boolean = url.startsWith("data:image/")
    }
}
