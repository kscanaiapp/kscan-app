package com.kscan.glasses.bridge

import java.util.Collections

/**
 * In-memory mock bridge provider for development, tests, and demo scenarios.
 *
 * **Mock-only — no real transport, no hardware, no backend calls.**
 *
 * Records sent messages and spoken/played text in memory for test assertions.
 * Simulates a connected display-capable glasses device by default.
 */
class MockBridgeProvider(
    initialState: DeviceState = DeviceState.MOCK_CONNECTED_DISPLAY
) : GlassesBridgeProvider {

    override var isConnected: Boolean = initialState.connected
        private set

    override var currentState: DeviceState? = initialState
        private set

    private var audioOnlyMode: Boolean = false

    private val _sentMessages = mutableListOf<BridgeMessage>()
    val sentMessages: List<BridgeMessage>
        get() = Collections.unmodifiableList(_sentMessages)

    private val _spokenText = mutableListOf<String>()
    val spokenText: List<String>
        get() = Collections.unmodifiableList(_spokenText)

    private val listeners = mutableListOf<GlassesBridgeProvider.BridgeListener>()

    override fun send(message: BridgeMessage) {
        _sentMessages.add(message)

        // Auto-update state on DeviceState messages
        if (message is BridgeMessage.DeviceState) {
            currentState = message.state
            isConnected = message.state.connected
        }

        // Notify listeners
        listeners.forEach { it.onMessage(message) }
    }

    override suspend fun sendToPhone(message: BridgeMessage): BridgeResult<Unit> {
        send(message)
        return BridgeResult.Success(Unit)
    }

    override suspend fun getDeviceState(): DeviceState {
        return currentState ?: DeviceState.MOCK_DISCONNECTED
    }

    override suspend fun openOnPhone(url: String) {
        // Mock — no real transport.
    }

    override suspend fun capturePhoto(): CaptureResult {
        return CaptureResult(
            base64 = "mock-base64-image-data",
            mimeType = "image/jpeg",
            source = CaptureSource.MOCK,
        )
    }

    override suspend fun speak(text: String) {
        _spokenText.add(text)
    }

    override fun registerListener(listener: GlassesBridgeProvider.BridgeListener) {
        listeners.add(listener)
    }

    override fun unregisterListener(listener: GlassesBridgeProvider.BridgeListener) {
        listeners.remove(listener)
    }

    override fun reset() {
        _sentMessages.clear()
        _spokenText.clear()
        listeners.clear()
        currentState = null
        isConnected = false
    }

    /** Simulate the glasses speaking text (for HUD voice-ready states). */
    fun setAudioOnlyMode(enabled: Boolean) {
        audioOnlyMode = enabled
        currentState = currentState?.let {
            it.copy(
                capabilities = it.capabilities.copy(
                    hasDisplay = !enabled,
                    isAudioOnly = enabled,
                )
            )
        }
    }

    /** Simulate receiving a message from the remote side (injects into listeners). */
    fun simulateIncoming(message: BridgeMessage) {
        listeners.forEach { it.onMessage(message) }
    }

    /** Convenience: simulate a connected state update. */
    fun simulateConnected(state: DeviceState = DeviceState.MOCK_CONNECTED_DISPLAY) {
        send(BridgeMessage.DeviceState(state = state))
    }

    /** Convenience: simulate a disconnection. */
    fun simulateDisconnected() {
        send(
            BridgeMessage.DeviceState(
                state = DeviceState.MOCK_DISCONNECTED
            )
        )
    }
}
