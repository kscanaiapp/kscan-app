package com.kscan.glasses.bridge

import android.content.Context
import android.util.Log
import java.util.UUID

/**
 * Production Google / Android XR bridge provider.
 *
 * TODO: Wire Jetpack Projected context APIs when target SDK / XR library versions are confirmed.
 * TODO: Delegate phone-hosted capture via sendToPhone(CAPTURE_PHOTO) when glasses camera unavailable.
 * TODO: Integrate Bluetooth / Wi-Fi transfer sessions from phone-bridge package contracts.
 */
class GoogleBridgeProvider(
    @Suppress("UNUSED_PARAMETER") private val context: Context,
) : GlassesBridgeProvider {

    override val providerId: String = "google"

    private val sessionId: String = UUID.randomUUID().toString()

    override suspend fun capturePhoto(): CaptureResult {
        // TODO: Android XR glasses camera API
        // Fallback: request phone capture through bridge
        Log.w(TAG, "GoogleBridgeProvider.capturePhoto not implemented — use MockBridgeProvider for alpha")
        throw UnsupportedOperationException("Google XR capture not yet implemented")
    }

    override suspend fun startPreview(): BridgeResult<Unit> {
        // TODO: Jetpack Projected preview surface
        return BridgeResult.Failure("UNSUPPORTED_CAPABILITY", "XR preview not wired", recoverable = true)
    }

    override suspend fun stopPreview(): BridgeResult<Unit> {
        return BridgeResult.Failure("UNSUPPORTED_CAPABILITY", "XR preview not wired", recoverable = true)
    }

    override suspend fun getDeviceState(): DeviceState {
        // TODO: Query real XR device capabilities at runtime
        return DeviceState(
            connected = false,
            batteryPercent = null,
            capabilities = DeviceCapabilities(
                hasDisplay = true,
                hasCamera = false,
                hasMicrophone = false,
                hasSpeaker = true,
                supportsProjectedContext = true,
                supportsBluetoothBridge = false,
                supportsWifiTransfer = false,
                supportsTouchpadOrGestureInput = false,
            ),
            bridgeMode = BridgeMode.GOOGLE,
            sessionId = sessionId,
        )
    }

    override suspend fun requestPermissions(): PermissionState {
        // TODO: XR projected permission flow + phone delegation
        return PermissionState(
            cameraGranted = false,
            microphoneGranted = false,
            bluetoothGranted = false,
            notificationsGranted = false,
            allRequiredGranted = false,
        )
    }

    override suspend fun sendToPhone(message: BridgeMessage): BridgeResult<Unit> {
        // TODO: Bluetooth / Supabase control lane
        return BridgeResult.Failure("BRIDGE_NOT_CONNECTED", "Phone bridge not connected", recoverable = true)
    }

    override suspend fun openOnPhone(deepLinkOrUrl: String): BridgeResult<Unit> {
        return sendToPhone(BridgeMessageFactory.openOnPhone(sessionId, deepLinkOrUrl))
    }

    override suspend fun vibrateOrHaptic(pattern: HapticPattern): BridgeResult<Unit> {
        // TODO: XR haptic API
        return BridgeResult.Failure("UNSUPPORTED_CAPABILITY", "Haptics not wired", recoverable = true)
    }

    override suspend fun speak(text: String): BridgeResult<Unit> {
        // TODO: Android TTS in projected context
        return BridgeResult.Failure("UNSUPPORTED_CAPABILITY", "TTS not wired", recoverable = true)
    }

    companion object {
        private const val TAG = "GoogleBridgeProvider"
    }
}
