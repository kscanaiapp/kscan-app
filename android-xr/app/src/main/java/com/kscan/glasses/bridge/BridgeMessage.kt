package com.kscan.glasses.bridge

import com.kscan.glasses.result.FashionAnalysisResult

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

    // ── Lifecycle / Handshake ───────────────────────────────────────────────

    /** Initial hello from glasses to phone or vice versa. */
    data class Hello(
        val deviceId: String,
        val version: String = "1.0.0-alpha",
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    /** Current device state broadcast (capabilities, battery, permissions). */
    data class DeviceState(
        val state: com.kscan.glasses.bridge.DeviceState,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    // ── Permissions ─────────────────────────────────────────────────────────

    /** Request permissions from the phone companion app. */
    data class RequestPermissions(
        val permissions: List<String>,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    /** Result of a permission request. */
    data class PermissionsResult(
        val granted: List<String>,
        val denied: List<String>,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    // ── Capture ─────────────────────────────────────────────────────────────

    /** Request a photo capture (initiated by glasses or phone). */
    data class CapturePhoto(
        val source: String = "glasses", // "glasses" | "phone" | "mock"
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    /** Photo successfully captured. **No image bytes in production.** */
    data class PhotoCaptured(
        val captureId: String,
        /** Safe placeholder only — no real image bytes in bridge messages. */
        val placeholderUri: String = "mock://photo-captured",
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    /** Photo capture failed. */
    data class PhotoError(
        val captureId: String,
        val reason: String,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    // ── Analysis ────────────────────────────────────────────────────────────

    /** Analysis started on a captured image. */
    data class AnalysisStarted(
        val analysisId: String,
        val captureId: String,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    /** Analysis completed with a result. */
    data class AnalysisResult(
        val analysisId: String,
        val result: FashionAnalysisResult,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    // ── Actions ─────────────────────────────────────────────────────────────

    /** Save a look/item to the user's library. */
    data class SaveItem(
        val itemId: String,
        val label: String,
        /** MOCK/DEMO only — no real thumbnail bytes. */
        val thumbnailPlaceholder: String = "mock://thumbnail",
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    /** Open a detailed view on the phone companion app. */
    data class OpenOnPhone(
        val itemId: String,
        val deepLinkPath: String = "/library/item",
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    // ── Auth / Session ──────────────────────────────────────────────────────

    /** Auth session reference (no token values in sample data). */
    data class AuthSession(
        val sessionRef: String = "mock-session-ref",
        val expiresAt: Long? = null,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)

    // ── Error ───────────────────────────────────────────────────────────────

    /** Generic bridge error. */
    data class Error(
        val code: String,
        val description: String,
        val recoverable: Boolean = false,
        override val messageId: String = java.util.UUID.randomUUID().toString()
    ) : BridgeMessage(messageId)
}
