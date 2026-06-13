package com.kscan.glasses.bridge

enum class CaptureSource {
    GLASSES,
    PHONE,
    MOCK,
}

data class CaptureResult(
    val base64: String,
    val mimeType: String,
    val source: CaptureSource,
)

enum class HapticPattern {
    LIGHT,
    MEDIUM,
    SUCCESS,
    ERROR,
}

sealed class BridgeResult<out T> {
    data class Success<T>(val value: T) : BridgeResult<T>()
    data class Failure(val code: String, val message: String, val recoverable: Boolean = true) : BridgeResult<Nothing>()
}

/**
 * Shared bridge interface for Google, Mock, and future Meta providers.
 * MetaBridgeProvider should implement this same contract without phone-bridge changes.
 */
interface GlassesBridgeProvider {
    val providerId: String

    suspend fun capturePhoto(): CaptureResult

    suspend fun startPreview(): BridgeResult<Unit> =
        BridgeResult.Failure("UNSUPPORTED_CAPABILITY", "Preview not available", recoverable = true)

    suspend fun stopPreview(): BridgeResult<Unit> =
        BridgeResult.Failure("UNSUPPORTED_CAPABILITY", "Preview not available", recoverable = true)

    suspend fun getDeviceState(): DeviceState

    suspend fun requestPermissions(): PermissionState

    suspend fun sendToPhone(message: BridgeMessage): BridgeResult<Unit>

    suspend fun openOnPhone(deepLinkOrUrl: String): BridgeResult<Unit>

    suspend fun vibrateOrHaptic(pattern: HapticPattern = HapticPattern.LIGHT): BridgeResult<Unit> =
        BridgeResult.Failure("UNSUPPORTED_CAPABILITY", "Haptics not available", recoverable = true)

    suspend fun speak(text: String): BridgeResult<Unit>
}
