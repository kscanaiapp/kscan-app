package com.kscan.glasses.camera

import com.kscan.glasses.bridge.BridgeMessage
import com.kscan.glasses.bridge.CaptureResult
import com.kscan.glasses.bridge.GlassesBridgeProvider

/**
 * Requests photo capture from companion phone when glasses have no camera.
 * TODO: Full CAPTURE_PHOTO / PHOTO_CAPTURED round-trip via phone-bridge.
 */
class PhoneCameraFallback(
    private val bridge: GlassesBridgeProvider,
) {
    suspend fun requestCapture(): CaptureResult? {
        val state = bridge.getDeviceState()
        val message = BridgeMessage.CapturePhoto(source = "phone")
        bridge.send(message)
        return null // async — phone will respond with PHOTO_CAPTURED
    }
}
