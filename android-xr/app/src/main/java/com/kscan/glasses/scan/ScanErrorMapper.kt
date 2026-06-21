package com.kscan.glasses.scan

import com.kscan.glasses.analyze.AnalyzeException

/**
 * Maps low-level analyze exceptions to user-friendly scan orchestrator errors.
 */
object ScanErrorMapper {

    fun map(exception: Throwable): ScanOrchestratorError {
        return when (exception) {
            is AnalyzeException.Disabled -> ScanOrchestratorError.BetaDisabled(exception.message ?: "Real analyze disabled")
            is AnalyzeException.Timeout -> ScanOrchestratorError.Timeout(exception.message ?: "Analysis timed out")
            is AnalyzeException.Network -> ScanOrchestratorError.Network(exception.message ?: "Network error")
            is AnalyzeException.HttpError -> ScanOrchestratorError.HttpError(exception.status, exception.message ?: "Server error")
            is AnalyzeException.MalformedJson -> ScanOrchestratorError.MalformedResponse(exception.message ?: "Malformed response")
            else -> ScanOrchestratorError.Unknown(exception.message ?: "Unknown error")
        }
    }

    fun toUserMessage(error: ScanOrchestratorError): String = when (error) {
        is ScanOrchestratorError.PrivacyBlocked -> "Privacy check blocked upload. Please retry."
        is ScanOrchestratorError.EncodeFailure -> "Image processing failed. Please retry."
        is ScanOrchestratorError.Timeout -> "Analysis timed out. Tap to retry."
        is ScanOrchestratorError.Network -> "Connection issue. Check network and retry."
        is ScanOrchestratorError.HttpError -> "Server error (${error.status}). Please retry."
        is ScanOrchestratorError.MalformedResponse -> "Server returned an unreadable response."
        is ScanOrchestratorError.BetaDisabled -> "Beta analyze is disabled."
        is ScanOrchestratorError.NonFashion -> error.userMessage
        is ScanOrchestratorError.Unknown -> "Something went wrong."
    }
}
