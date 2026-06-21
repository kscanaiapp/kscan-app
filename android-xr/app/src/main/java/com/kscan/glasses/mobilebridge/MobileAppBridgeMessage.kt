package com.kscan.glasses.mobilebridge

/**
 * Sealed message hierarchy for mobile app bridge communication.
 *
 * No image bytes, no base64, no tokens, no secrets.
 */
sealed class MobileAppBridgeMessage {

    data class SaveItem(
        val itemId: String,
        val label: String,
    ) : MobileAppBridgeMessage()

    data class OpenResult(
        val resultId: String,
    ) : MobileAppBridgeMessage()

    data class RequestSession(
        val glassesSessionId: String,
    ) : MobileAppBridgeMessage()

    data class HandoffAck(
        val route: String,
        val success: Boolean,
    ) : MobileAppBridgeMessage()
}
