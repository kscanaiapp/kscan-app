package com.kscan.glasses.bridge

data class DeviceCapabilities(
    val hasDisplay: Boolean,
    val hasCamera: Boolean,
    val hasMicrophone: Boolean,
    val hasSpeaker: Boolean,
    val supportsProjectedContext: Boolean,
    val supportsBluetoothBridge: Boolean,
    val supportsWifiTransfer: Boolean,
    val supportsTouchpadOrGestureInput: Boolean,
) {
    companion object {
        fun mockDisplayGlasses() = DeviceCapabilities(
            hasDisplay = true,
            hasCamera = true,
            hasMicrophone = true,
            hasSpeaker = true,
            supportsProjectedContext = true,
            supportsBluetoothBridge = true,
            supportsWifiTransfer = true,
            supportsTouchpadOrGestureInput = true,
        )

        fun mockAudioOnlyGlasses() = DeviceCapabilities(
            hasDisplay = false,
            hasCamera = true,
            hasMicrophone = true,
            hasSpeaker = true,
            supportsProjectedContext = true,
            supportsBluetoothBridge = true,
            supportsWifiTransfer = false,
            supportsTouchpadOrGestureInput = true,
        )
    }
}
