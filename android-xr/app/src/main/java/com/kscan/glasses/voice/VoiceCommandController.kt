package com.kscan.glasses.voice

import com.kscan.glasses.navigation.GlassesInput

enum class VoiceAction {
    WAKE,
    SCAN,
    WHAT_AM_I_LOOKING_AT,
    FIND_SIMILAR,
    SAVE,
    NEXT,
    PREVIOUS,
    OPEN_ON_PHONE,
    GO_BACK,
    UNKNOWN,
}

/**
 * Parses voice transcripts into actions. Does not implement always-on wake word.
 */
class VoiceCommandController {

    fun parse(transcript: String): Pair<VoiceAction, GlassesInput?> {
        val normalized = transcript.trim().lowercase()
        if (!normalized.startsWith("k scan")) {
            return VoiceAction.UNKNOWN to null
        }

        val rest = normalized.removePrefix("k scan").trim()

        return when {
            rest.isEmpty() -> VoiceAction.WAKE to null
            rest == "scan this" || rest == "scan" -> VoiceAction.SCAN to GlassesInput.ScanShortcut
            rest == "what am i looking at" -> VoiceAction.WHAT_AM_I_LOOKING_AT to GlassesInput.ScanShortcut
            rest == "find similar" -> VoiceAction.FIND_SIMILAR to GlassesInput.ScanShortcut
            rest == "save this" || rest == "save" -> VoiceAction.SAVE to GlassesInput.Select
            rest == "next" -> VoiceAction.NEXT to GlassesInput.Down
            rest == "previous" || rest == "prev" -> VoiceAction.PREVIOUS to GlassesInput.Up
            rest == "open on phone" -> VoiceAction.OPEN_ON_PHONE to GlassesInput.Select
            rest == "go back" || rest == "back" -> VoiceAction.GO_BACK to GlassesInput.Back
            else -> VoiceAction.UNKNOWN to null
        }
    }
}
