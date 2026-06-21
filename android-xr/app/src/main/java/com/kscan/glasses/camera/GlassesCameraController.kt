package com.kscan.glasses.camera

/**
 * Glasses-integrated camera controller.
 * TODO: Android XR / Jetpack Projected camera APIs (version-sensitive).
 */
class GlassesCameraController {
    suspend fun captureStill(): Result<CapturePayload> {
        return Result.failure(UnsupportedOperationException("Glasses camera not implemented"))
    }

    data class CapturePayload(val base64: String, val mimeType: String)
}
