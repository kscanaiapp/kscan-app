package com.kscan.glasses.voice

import com.kscan.glasses.bridge.BridgeResult
import com.kscan.glasses.bridge.GlassesBridgeProvider

class SpeechFeedback(
    private val bridge: GlassesBridgeProvider,
) {
    suspend fun speakSummary(summary: String): BridgeResult<Unit> {
        val trimmed = summary.take(240)
        return bridge.speak(trimmed)
    }
}
