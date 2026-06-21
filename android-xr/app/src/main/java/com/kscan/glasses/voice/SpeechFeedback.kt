package com.kscan.glasses.voice

import com.kscan.glasses.bridge.GlassesBridgeProvider

class SpeechFeedback(
    private val bridge: GlassesBridgeProvider,
) {
    suspend fun speakSummary(summary: String) {
        val trimmed = summary.take(240)
        bridge.speak(trimmed)
    }
}
