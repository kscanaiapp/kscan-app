package com.kscan.glasses.analyze

/**
 * Analyze client boundary interface.
 *
 * No payload logging, no credentials, no live calls unless explicitly enabled.
 */
interface AnalyzeClient {
    suspend fun analyze(request: AnalyzeRequest): AnalyzeResponse
}
