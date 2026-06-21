package com.kscan.glasses.bridge

/**
 * Represents the hardware and software capabilities of a connected glasses device.
 *
 * This is a pure model — no transport implementation, no hardware APIs.
 * All properties are typed booleans to avoid ambiguous null states.
 */
data class DeviceCapabilities(
    /** True if the glasses can display visual content (projected or direct). */
    val hasDisplay: Boolean = true,

    /** True if the glasses are audio-only (no visual display). */
    val isAudioOnly: Boolean = false,

    /** True if a camera is present on the glasses or companion device. */
    val hasCamera: Boolean = false,

    /** True if a microphone is available for voice input. */
    val hasMicrophone: Boolean = true,

    /** True if a speaker or bone-conduction audio output is available. */
    val hasSpeaker: Boolean = true,

    /** True if the device supports projected context (e.g., Jetpack Projected). **Future capability only.** */
    val supportsProjectedContext: Boolean = false,

    /** True if Bluetooth bridge transport is available. **Future capability only — not implemented.** */
    val supportsBluetoothBridge: Boolean = false,

    /** True if Wi-Fi direct transfer is available. **Future capability only — not implemented.** */
    val supportsWiFiTransfer: Boolean = false,

    /** True if touchpad or gesture input is available. **Future capability only — not implemented.** */
    val supportsTouchpadGestures: Boolean = false
) {
    init {
        require(!(hasDisplay && isAudioOnly)) {
            "A device cannot be both display-capable and audio-only."
        }
    }

    companion object {
        /** Mock display-capable glasses for development/demo. */
        val MOCK_DISPLAY_GLASSES = DeviceCapabilities(
            hasDisplay = true,
            isAudioOnly = false,
            hasCamera = true,
            hasMicrophone = true,
            hasSpeaker = true,
            supportsProjectedContext = false,
            supportsBluetoothBridge = false,
            supportsWiFiTransfer = false,
            supportsTouchpadGestures = false
        )

        /** Mock audio-only glasses for development/demo. */
        val MOCK_AUDIO_ONLY_GLASSES = DeviceCapabilities(
            hasDisplay = false,
            isAudioOnly = true,
            hasCamera = false,
            hasMicrophone = true,
            hasSpeaker = true,
            supportsProjectedContext = false,
            supportsBluetoothBridge = false,
            supportsWiFiTransfer = false,
            supportsTouchpadGestures = false
        )

        /** Convenience factory for tests. */
        fun mockDisplayGlasses(): DeviceCapabilities = MOCK_DISPLAY_GLASSES.copy()
    }
}
