package com.kscan.glasses.bridge

data class DeviceState(
    val connected: Boolean,
    val batteryPercent: Int?,
    val capabilities: DeviceCapabilities,
    val bridgeMode: BridgeMode,
    val sessionId: String,
)

enum class BridgeMode {
    MOCK,
    PHONE,
    GOOGLE,
}
