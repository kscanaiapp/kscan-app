package com.kscan.glasses.voice

/**
 * Voice command model for glasses text-only input.
 *
 * No real microphone, no SpeechRecognizer, no MediaRecorder.
 */
data class VoiceCommand(
    val command: String,
    val args: List<String> = emptyList(),
)

enum class VoiceCommandType {
    WAKE,
    SCAN,
    SAVE,
    OPEN_ON_PHONE,
    GO_BACK,
    NEXT,
    PREVIOUS,
    UNKNOWN,
}
