package com.kscan.glasses.bridge

/**
 * Placeholder for future Google glasses bridge integration.
 *
 * **This is a stub only. It does NOT:**
 * - Import or use Jetpack XR
 * - Import or use Glimmer
 * - Import or use Cast
 * - Import or use Bluetooth APIs
 * - Import or use Wi-Fi APIs
 * - Claim real hardware support
 * - Implement real transport
 *
 * When real integration is needed, this class will be replaced or extended
 * with the actual Google glasses SDK dependencies behind a feature flag.
 */
class GoogleBridgeProvider : GlassesBridgeProvider {

    override val isConnected: Boolean = false

    override val currentState: DeviceState? = null

    override fun send(message: BridgeMessage) {
        // Placeholder — no real transport.
        // TODO: Implement real Google glasses bridge transport when SDK is available.
    }

    override suspend fun sendToPhone(message: BridgeMessage): BridgeResult<Unit> {
        return BridgeResult.Failure(UnsupportedOperationException("Google bridge not implemented"))
    }

    override suspend fun getDeviceState(): DeviceState {
        return DeviceState.MOCK_DISCONNECTED
    }

    override suspend fun openOnPhone(url: String) {
        // Placeholder — no real transport.
    }

    override suspend fun capturePhoto(): CaptureResult {
        throw UnsupportedOperationException("Google bridge capture not implemented")
    }

    override suspend fun speak(text: String) {
        // Placeholder — no audio output.
    }

    override fun registerListener(listener: GlassesBridgeProvider.BridgeListener) {
        // Placeholder — no real listeners.
    }

    override fun unregisterListener(listener: GlassesBridgeProvider.BridgeListener) {
        // Placeholder — no real listeners.
    }

    override fun reset() {
        // Placeholder — no state to clear.
    }
}
