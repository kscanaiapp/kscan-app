package com.kscan.glasses.analyze

/**
 * Analyze exception hierarchy.
 *
 * Safe for logging — no payload, no image bytes, no base64.
 */
sealed class AnalyzeException(message: String) : Exception(message) {
    class Network(message: String) : AnalyzeException(message)
    class Timeout(message: String) : AnalyzeException(message)
    class HttpError(val status: Int, message: String) : AnalyzeException(message)
    class MalformedJson(message: String) : AnalyzeException(message)
    class Disabled(message: String) : AnalyzeException(message)
}
