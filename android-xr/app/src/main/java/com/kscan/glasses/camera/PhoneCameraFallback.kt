package com.kscan.glasses.camera

import com.kscan.glasses.bridge.BridgeMessageFactory
import com.kscan.glasses.bridge.BridgeMessageType
import com.kscan.glasses.bridge.BridgeResult
import com.kscan.glasses.bridge.CaptureResult
import com.kscan.glasses.bridge.CaptureSource
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
        val message = BridgeMessageFactory.deviceState(state).copy(
            type = BridgeMessageType.CAPTURE_PHOTO.name,
        )
        return when (val result = bridge.sendToPhone(message)) {
            is BridgeResult.Success -> null // async — phone will respond with PHOTO_CAPTURED
            is BridgeResult.Failure -> null
        }
    }
}
