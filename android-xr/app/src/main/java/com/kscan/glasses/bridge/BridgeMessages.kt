package com.kscan.glasses.bridge

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

enum class BridgeMessageType {
    HELLO,
    DEVICE_STATE,
    REQUEST_PERMISSIONS,
    PERMISSIONS_RESULT,
    CAPTURE_PHOTO,
    PHOTO_CAPTURED,
    PHOTO_ERROR,
    ANALYSIS_STARTED,
    ANALYSIS_RESULT,
    SAVE_ITEM,
    OPEN_ON_PHONE,
    AUTH_SESSION,
    ERROR,
}

@Serializable
data class BridgeMessage(
    val type: String,
    val timestamp: Long,
    val sessionId: String,
    val requestId: String? = null,
    val payload: JsonElement? = null,
)

object BridgeMessageFactory {
    fun deviceState(state: DeviceState): BridgeMessage = BridgeMessage(
        type = BridgeMessageType.DEVICE_STATE.name,
        timestamp = System.currentTimeMillis(),
        sessionId = state.sessionId,
        payload = null, // serialized at send boundary in production
    )

    fun analysisResult(sessionId: String, requestId: String): BridgeMessage = BridgeMessage(
        type = BridgeMessageType.ANALYSIS_RESULT.name,
        timestamp = System.currentTimeMillis(),
        sessionId = sessionId,
        requestId = requestId,
    )

    fun openOnPhone(sessionId: String, url: String): BridgeMessage = BridgeMessage(
        type = BridgeMessageType.OPEN_ON_PHONE.name,
        timestamp = System.currentTimeMillis(),
        sessionId = sessionId,
        requestId = url.hashCode().toString(),
    )

    fun saveItem(sessionId: String, productId: String): BridgeMessage = BridgeMessage(
        type = BridgeMessageType.SAVE_ITEM.name,
        timestamp = System.currentTimeMillis(),
        sessionId = sessionId,
        requestId = productId,
    )

    fun error(sessionId: String, code: String, message: String, recoverable: Boolean = true): BridgeMessage =
        BridgeMessage(
            type = BridgeMessageType.ERROR.name,
            timestamp = System.currentTimeMillis(),
            sessionId = sessionId,
            requestId = code,
        )
}
