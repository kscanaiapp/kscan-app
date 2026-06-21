package com.kscan.glasses.bridge

/**
 * Represents the runtime state of a connected glasses device.
 *
 * Pure model — no transport, no hardware state polling.
 */
data class DeviceState(
    val deviceId: String,
    val capabilities: DeviceCapabilities,
    val isConnected: Boolean = false,
    val batteryPercent: Int? = null,
    val isCharging: Boolean = false,
    val permissionState: PermissionState = PermissionState.default(),
    val lastError: String? = null
) {
    companion object {
        /** Mock state for a connected display-capable device. */
        val MOCK_CONNECTED_DISPLAY = DeviceState(
            deviceId = "mock-glasses-display-001",
            capabilities = DeviceCapabilities.MOCK_DISPLAY_GLASSES,
            isConnected = true,
            batteryPercent = 72,
            isCharging = false,
            permissionState = PermissionState.allGranted()
        )

        /** Mock state for an audio-only device. */
        val MOCK_CONNECTED_AUDIO_ONLY = DeviceState(
            deviceId = "mock-glasses-audio-002",
            capabilities = DeviceCapabilities.MOCK_AUDIO_ONLY_GLASSES,
            isConnected = true,
            batteryPercent = 45,
            isCharging = false,
            permissionState = PermissionState.allGranted()
        )

        /** Mock state for a disconnected device. */
        val MOCK_DISCONNECTED = DeviceState(
            deviceId = "mock-glasses-disconnected",
            capabilities = DeviceCapabilities.MOCK_DISPLAY_GLASSES,
            isConnected = false,
            batteryPercent = null,
            isCharging = false,
            permissionState = PermissionState.default()
        )
    }
}
