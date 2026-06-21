package com.kscan.glasses.voice

/**
 * Text-only voice command parser for planned commands.
 *
 * Supported phrases:
 * - "K Scan" -> WAKE
 * - "K Scan scan this" -> SCAN
 * - "K Scan save this" -> SAVE
 * - "K Scan open on phone" -> OPEN_ON_PHONE
 * - "K Scan go back" -> GO_BACK
 * - "K Scan next" -> NEXT
 * - "K Scan previous" -> PREVIOUS
 *
 * No real microphone, no SpeechRecognizer, no MediaRecorder.
 */
object VoiceCommandParser {

    private val WAKE_PREFIXES = setOf("k scan", "kscan", "hey k scan")

    fun parse(transcript: String): VoiceCommandType {
        val lower = transcript.trim().lowercase()
        if (!WAKE_PREFIXES.any { lower.startsWith(it) }) {
            return VoiceCommandType.UNKNOWN
        }

        val afterWake = WAKE_PREFIXES.fold(lower) { acc, prefix ->
            if (acc.startsWith(prefix)) acc.removePrefix(prefix).trim() else acc
        }

        return when {
            afterWake.isEmpty() -> VoiceCommandType.WAKE
            afterWake.contains("scan") -> VoiceCommandType.SCAN
            afterWake.contains("save") -> VoiceCommandType.SAVE
            afterWake.contains("open on phone") || afterWake.contains("open phone") -> VoiceCommandType.OPEN_ON_PHONE
            afterWake.contains("go back") || afterWake.contains("back") -> VoiceCommandType.GO_BACK
            afterWake.contains("next") -> VoiceCommandType.NEXT
            afterWake.contains("previous") || afterWake.contains("prev") -> VoiceCommandType.PREVIOUS
            else -> VoiceCommandType.UNKNOWN
        }
    }
}
