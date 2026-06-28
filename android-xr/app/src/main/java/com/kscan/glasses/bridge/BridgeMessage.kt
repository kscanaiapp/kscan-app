package com.kscan.glasses.bridge

import com.kscan.glasses.state.FashionAnalyzeResult

/**
 * Typed bridge messages for glasses → phone and phone → glasses communication.
 *
 * This is a **contract-only** sealed class. No wire serialization, no transport,
 * no image bytes except safe mock/test placeholders, no auth tokens.
 *
 * All messages are immutable data classes. If a message needs to carry a
 * reference identifier, use a lightweight [messageId] string.
 */
sealed class BridgeMessage(
    open val messageId: String = java.util.UUID.randomUUID().toString()
) {
    abstract val type: String

    // ── Lifecycle / Handshake ───────────────────────────────────────────────

    /** Initial hello from glasses to phone or vice versa. */
    data class Hello(
        val deviceId: String,
        val version: String = "1.0.0-alpha",
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.HELLO.name
    }

    /** Current device state broadcast (capabilities, battery, permissions). */
    data class DeviceState(
        val state: com.kscan.glasses.bridge.DeviceState,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.DEVICE_STATE.name
    }

    // ── Permissions ─────────────────────────────────────────────────────────

    /** Request permissions from the phone companion app. */
    data class RequestPermissions(
        val permissions: List<String>,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.REQUEST_PERMISSIONS.name
    }

    /** Result of a permission request. */
    data class PermissionsResult(
        val granted: List<String>,
        val denied: List<String>,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.PERMISSIONS_RESULT.name
    }

    // ── Capture ─────────────────────────────────────────────────────────────

    /** Request a photo capture (initiated by glasses or phone). */
    data class CapturePhoto(
        val source: String = "glasses", // "glasses" | "phone" | "mock"
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.CAPTURE_PHOTO.name
    }

    /** Photo successfully captured. **No image bytes in production.** */
    data class PhotoCaptured(
        val captureId: String,
        /** Safe placeholder only — no real image bytes in bridge messages. */
        val placeholderUri: String = "mock://photo-captured",
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.PHOTO_CAPTURED.name
    }

    /** Photo capture failed. */
    data class PhotoError(
        val captureId: String,
        val reason: String,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.PHOTO_ERROR.name
    }

    // ── Analysis ────────────────────────────────────────────────────────────

    /** Analysis started on a captured image. */
    data class AnalysisStarted(
        val analysisId: String,
        val captureId: String,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.ANALYSIS_STARTED.name
    }

    /** Analysis completed with a result. */
    data class AnalysisResult(
        val analysisId: String,
        val result: FashionAnalyzeResult,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.ANALYSIS_RESULT.name
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    /** Save a look/item to the user's closet. */
    data class SaveItem(
        val itemId: String,
        val label: String,
        /** MOCK/DEMO only — no real thumbnail bytes. */
        val thumbnailPlaceholder: String = "mock://thumbnail",
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.SAVE_ITEM.name
    }

    /** Open a detailed view on the phone companion app. */
    data class OpenOnPhone(
        val itemId: String,
        val deepLinkPath: String = "/library/item",
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.OPEN_ON_PHONE.name
    }

    // ── Auth / Session ──────────────────────────────────────────────────────

    /** Auth session reference (no token values in sample data). */
    data class AuthSession(
        val sessionRef: String = "mock-session-ref",
        val expiresAt: Long? = null,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.AUTH_SESSION.name
    }

    // ── Error ───────────────────────────────────────────────────────────────

    /** Generic bridge error. */
    data class Error(
        val code: String,
        val description: String,
        val recoverable: Boolean = false,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId) {
        override val type = BridgeMessageType.ERROR.name
    }
}
