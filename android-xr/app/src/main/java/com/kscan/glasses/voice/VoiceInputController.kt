package com.kscan.glasses.voice

/**
 * Voice input controller contract.
 *
 * No real microphone. No SpeechRecognizer. No MediaRecorder.
 * Implementations may be text-only mock for tests.
 */
interface VoiceInputController {
    val mode: VoiceActivationMode
    val isListening: Boolean
    fun startListening()
    fun stopListening()
    fun setMode(mode: VoiceActivationMode)
    fun simulateCommand(command: String)
}
