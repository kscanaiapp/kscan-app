package com.kscan.glasses.bridge

/**
 * Represents the runtime state of a connected glasses device.
 *
 * Pure model — no transport, no hardware state polling.
 */
data class DeviceState(
    val deviceId: String = "mock-device",
    val capabilities: DeviceCapabilities,
    val connected: Boolean = false,
    val batteryPercent: Int? = null,
    val isCharging: Boolean = false,
    val permissionState: PermissionState = PermissionState.default(),
    val lastError: String? = null,
    val sessionId: String = "mock-session",
    val bridgeMode: BridgeMode = BridgeMode.MOCK,
) {
    companion object {
        /** Mock state for a connected display-capable device. */
        val MOCK_CONNECTED_DISPLAY = DeviceState(
            deviceId = "mock-glasses-display-001",
            capabilities = DeviceCapabilities.MOCK_DISPLAY_GLASSES,
            connected = true,
            batteryPercent = 72,
            isCharging = false,
            permissionState = PermissionState.allGranted(),
            sessionId = "mock-session-display",
            bridgeMode = BridgeMode.MOCK,
        )

        /** Mock state for an audio-only device. */
        val MOCK_CONNECTED_AUDIO_ONLY = DeviceState(
            deviceId = "mock-glasses-audio-002",
            capabilities = DeviceCapabilities.MOCK_AUDIO_ONLY_GLASSES,
            connected = true,
            batteryPercent = 45,
            isCharging = false,
            permissionState = PermissionState.allGranted(),
            sessionId = "mock-session-audio",
            bridgeMode = BridgeMode.MOCK,
        )

        /** Mock state for a disconnected device. */
        val MOCK_DISCONNECTED = DeviceState(
            deviceId = "mock-glasses-disconnected",
            capabilities = DeviceCapabilities.MOCK_DISPLAY_GLASSES,
            connected = false,
            batteryPercent = null,
            isCharging = false,
            permissionState = PermissionState.default(),
            sessionId = "mock-session-disconnected",
            bridgeMode = BridgeMode.MOCK,
        )
    }
}
