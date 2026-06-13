package com.kscan.glasses.bridge

import android.content.Context
import android.util.Base64
import android.util.Log
import com.kscan.glasses.BuildConfig
import kotlinx.coroutines.delay
import java.util.UUID

/**
 * Mock bridge for emulator / CI without physical XR hardware.
 */
class MockBridgeProvider(
    private val context: Context,
) : GlassesBridgeProvider {

    override val providerId: String = "mock"

    var simulatedCapabilities: DeviceCapabilities = DeviceCapabilities.mockDisplayGlasses()
        private set

    private val sessionId: String = UUID.randomUUID().toString()
    private val outboundMessages = mutableListOf<BridgeMessage>()

    fun setAudioOnlyMode(enabled: Boolean) {
        simulatedCapabilities = if (enabled) {
            DeviceCapabilities.mockAudioOnlyGlasses()
        } else {
            DeviceCapabilities.mockDisplayGlasses()
        }
    }

    fun lastOutboundMessages(): List<BridgeMessage> = outboundMessages.toList()

    override suspend fun capturePhoto(): CaptureResult {
        delay(150)
        val bytes = loadMockImageBytes()
        return CaptureResult(
            base64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
            mimeType = "image/jpeg",
            source = CaptureSource.MOCK,
        )
    }

    override suspend fun getDeviceState(): DeviceState = DeviceState(
        connected = true,
        batteryPercent = 87,
        capabilities = simulatedCapabilities,
        bridgeMode = BridgeMode.MOCK,
        sessionId = sessionId,
    )

    override suspend fun requestPermissions(): PermissionState = PermissionState(
        cameraGranted = true,
        microphoneGranted = simulatedCapabilities.hasMicrophone,
        bluetoothGranted = simulatedCapabilities.supportsBluetoothBridge,
        notificationsGranted = true,
        allRequiredGranted = true,
    )

    override suspend fun sendToPhone(message: BridgeMessage): BridgeResult<Unit> {
        outboundMessages.add(message)
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "sendToPhone type=${message.type} session=${message.sessionId}")
        }
        return BridgeResult.Success(Unit)
    }

    override suspend fun openOnPhone(deepLinkOrUrl: String): BridgeResult<Unit> {
        val msg = BridgeMessageFactory.openOnPhone(sessionId, deepLinkOrUrl)
        return sendToPhone(msg)
    }

    override suspend fun vibrateOrHaptic(pattern: HapticPattern): BridgeResult<Unit> {
        return BridgeResult.Success(Unit)
    }

    override suspend fun speak(text: String): BridgeResult<Unit> {
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "speak len=${text.length}")
        }
        return BridgeResult.Success(Unit)
    }

    private fun loadMockImageBytes(): ByteArray {
        // Minimal valid 1×1 JPEG — no faces, safe for mock analyze
        return byteArrayOf(
            0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xDB.toByte(), 0x00.toByte(), 0x43.toByte(),
            0x00.toByte(), 0x08.toByte(), 0x06.toByte(), 0x06.toByte(), 0x07.toByte(), 0x06.toByte(),
            0x05.toByte(), 0x08.toByte(), 0x07.toByte(), 0x07.toByte(), 0x07.toByte(), 0x09.toByte(),
            0x09.toByte(), 0x08.toByte(), 0x0A.toByte(), 0x0C.toByte(), 0x14.toByte(), 0x0D.toByte(),
            0x0C.toByte(), 0x0B.toByte(), 0x0B.toByte(), 0x0C.toByte(), 0x19.toByte(), 0x12.toByte(),
            0x13.toByte(), 0x0F.toByte(), 0x14.toByte(), 0x1D.toByte(), 0x1A.toByte(), 0x1F.toByte(),
            0x1E.toByte(), 0x1D.toByte(), 0x1A.toByte(), 0x1C.toByte(), 0x1C.toByte(), 0x20.toByte(),
            0x24.toByte(), 0x2E.toByte(), 0x27.toByte(), 0x20.toByte(), 0x22.toByte(), 0x2C.toByte(),
            0x23.toByte(), 0x1C.toByte(), 0x1C.toByte(), 0x28.toByte(), 0x37.toByte(), 0x29.toByte(),
            0x2C.toByte(), 0x30.toByte(), 0x31.toByte(), 0x34.toByte(), 0x34.toByte(), 0x34.toByte(),
            0x1F.toByte(), 0x27.toByte(), 0x39.toByte(), 0x3D.toByte(), 0x38.toByte(), 0x32.toByte(),
            0x3C.toByte(), 0x2E.toByte(), 0x33.toByte(), 0x34.toByte(), 0x32.toByte(), 0xFF.toByte(),
            0xC0.toByte(), 0x00.toByte(), 0x0B.toByte(), 0x08.toByte(), 0x00.toByte(), 0x01.toByte(),
            0x00.toByte(), 0x01.toByte(), 0x01.toByte(), 0x01.toByte(), 0x11.toByte(), 0x00.toByte(),
            0xFF.toByte(), 0xC4.toByte(), 0x00.toByte(), 0x1F.toByte(), 0x00.toByte(), 0x00.toByte(),
            0x01.toByte(), 0x05.toByte(), 0x01.toByte(), 0x01.toByte(), 0x01.toByte(), 0x01.toByte(),
            0x01.toByte(), 0x01.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(),
            0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x01.toByte(), 0x02.toByte(),
            0x03.toByte(), 0x04.toByte(), 0x05.toByte(), 0x06.toByte(), 0x07.toByte(), 0x08.toByte(),
            0x09.toByte(), 0x0A.toByte(), 0x0B.toByte(), 0xFF.toByte(), 0xC4.toByte(), 0x00.toByte(),
            0xB5.toByte(), 0x10.toByte(), 0x00.toByte(), 0x02.toByte(), 0x01.toByte(), 0x03.toByte(),
            0x03.toByte(), 0x02.toByte(), 0x04.toByte(), 0x03.toByte(), 0x05.toByte(), 0x05.toByte(),
            0x04.toByte(), 0x04.toByte(), 0x00.toByte(), 0x00.toByte(), 0x01.toByte(), 0x7D.toByte(),
            0x01.toByte(), 0x02.toByte(), 0x03.toByte(), 0x00.toByte(), 0x04.toByte(), 0x11.toByte(),
            0x05.toByte(), 0x12.toByte(), 0x21.toByte(), 0x31.toByte(), 0x41.toByte(), 0x06.toByte(),
            0x13.toByte(), 0x51.toByte(), 0x61.toByte(), 0x07.toByte(), 0x22.toByte(), 0x71.toByte(),
            0x14.toByte(), 0x32.toByte(), 0x81.toByte(), 0x91.toByte(), 0xA1.toByte(), 0x08.toByte(),
            0x23.toByte(), 0x42.toByte(), 0xB1.toByte(), 0xC1.toByte(), 0x15.toByte(), 0x52.toByte(),
            0xD1.toByte(), 0xF0.toByte(), 0x24.toByte(), 0x33.toByte(), 0x62.toByte(), 0x72.toByte(),
            0x82.toByte(), 0x09.toByte(), 0x0A.toByte(), 0x16.toByte(), 0x17.toByte(), 0x18.toByte(),
            0x19.toByte(), 0x1A.toByte(), 0x25.toByte(), 0x26.toByte(), 0x27.toByte(), 0x28.toByte(),
            0x29.toByte(), 0x2A.toByte(), 0x34.toByte(), 0x35.toByte(), 0x36.toByte(), 0x37.toByte(),
            0x38.toByte(), 0x39.toByte(), 0x3A.toByte(), 0x43.toByte(), 0x44.toByte(), 0x45.toByte(),
            0x46.toByte(), 0x47.toByte(), 0x48.toByte(), 0x49.toByte(), 0x4A.toByte(), 0x53.toByte(),
            0x54.toByte(), 0x55.toByte(), 0x56.toByte(), 0x57.toByte(), 0x58.toByte(), 0x59.toByte(),
            0x5A.toByte(), 0x63.toByte(), 0x64.toByte(), 0x65.toByte(), 0x66.toByte(), 0x67.toByte(),
            0x68.toByte(), 0x69.toByte(), 0x6A.toByte(), 0x73.toByte(), 0x74.toByte(), 0x75.toByte(),
            0x76.toByte(), 0x77.toByte(), 0x78.toByte(), 0x79.toByte(), 0x7A.toByte(), 0x83.toByte(),
            0x84.toByte(), 0x85.toByte(), 0x86.toByte(), 0x87.toByte(), 0x88.toByte(), 0x89.toByte(),
            0x8A.toByte(), 0x92.toByte(), 0x93.toByte(), 0x94.toByte(), 0x95.toByte(), 0x96.toByte(),
            0x97.toByte(), 0x98.toByte(), 0x99.toByte(), 0x9A.toByte(), 0xA2.toByte(), 0xA3.toByte(),
            0xA4.toByte(), 0xA5.toByte(), 0xA6.toByte(), 0xA7.toByte(), 0xA8.toByte(), 0xA9.toByte(),
            0xAA.toByte(), 0xB2.toByte(), 0xB3.toByte(), 0xB4.toByte(), 0xB5.toByte(), 0xB6.toByte(),
            0xB7.toByte(), 0xB8.toByte(), 0xB9.toByte(), 0xBA.toByte(), 0xC2.toByte(), 0xC3.toByte(),
            0xC4.toByte(), 0xC5.toByte(), 0xC6.toByte(), 0xC7.toByte(), 0xC8.toByte(), 0xC9.toByte(),
            0xCA.toByte(), 0xD2.toByte(), 0xD3.toByte(), 0xD4.toByte(), 0xD5.toByte(), 0xD6.toByte(),
            0xD7.toByte(), 0xD8.toByte(), 0xD9.toByte(), 0xDA.toByte(), 0xE1.toByte(), 0xE2.toByte(),
            0xE3.toByte(), 0xE4.toByte(), 0xE5.toByte(), 0xE6.toByte(), 0xE7.toByte(), 0xE8.toByte(),
            0xE9.toByte(), 0xEA.toByte(), 0xF1.toByte(), 0xF2.toByte(), 0xF3.toByte(), 0xF4.toByte(),
            0xF5.toByte(), 0xF6.toByte(), 0xF7.toByte(), 0xF8.toByte(), 0xF9.toByte(), 0xFA.toByte(),
            0xFF.toByte(), 0xDA.toByte(), 0x00.toByte(), 0x08.toByte(), 0x01.toByte(), 0x01.toByte(),
            0x00.toByte(), 0x00.toByte(), 0x3F.toByte(), 0x00.toByte(), 0xFB.toByte(), 0xD5.toByte(),
            0xDB.toByte(), 0x20.toByte(), 0xA8.toByte(), 0xF3.toByte(), 0xFF.toByte(), 0xD9.toByte(),
        )
    }

    companion object {
        private const val TAG = "MockBridgeProvider"
    }
}
