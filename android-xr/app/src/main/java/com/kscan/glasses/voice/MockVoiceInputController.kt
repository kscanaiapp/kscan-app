package com.kscan.glasses.voice

/**
 * Mock voice input controller for tests and local development.
 *
 * No real microphone. No SpeechRecognizer. No MediaRecorder.
 */
class MockVoiceInputController : VoiceInputController {

    override var mode: VoiceActivationMode = VoiceActivationMode.PUSH_TO_TALK
        private set

    override var isListening: Boolean = false
        private set

    private val _commands = mutableListOf<String>()
    val commands: List<String> get() = _commands.toList()

    override fun startListening() {
        isListening = true
    }

    override fun stopListening() {
        isListening = false
    }

    override fun setMode(mode: VoiceActivationMode) {
        this.mode = mode
    }

    override fun simulateCommand(command: String) {
        _commands.add(command)
    }

    fun reset() {
        _commands.clear()
        isListening = false
        mode = VoiceActivationMode.PUSH_TO_TALK
    }
}
