package com.kscan.glasses.phonebridge

import com.kscan.glasses.scan.ScanErrorCode
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Versioned phone-bridge wire contract for the Google XR glasses runtime.
 *
 * Every message carries the same envelope fields: [protocolVersion], [messageType],
 * [requestId], [sessionId], [deviceId] (the SENDER's device id), [timestamp], and an
 * optional [expiresAt]. Message bodies carry references only — no image bytes, no
 * tokens, no credentials. See docs/google/PHONE_BRIDGE_PROTOCOL.md.
 */
@Serializable
sealed class PhoneBridgeMessage {
    abstract val protocolVersion: Int
    abstract val requestId: String
    abstract val sessionId: String
    abstract val deviceId: String
    abstract val timestamp: Long
    abstract val expiresAt: Long?
    abstract val payload: PhoneBridgePayload

    /** Wire type discriminator. Getter-only so it is never serialized as a field. */
    abstract val messageType: String

    // ----- pair.* -----

    @Serializable
    @SerialName("pair.request")
    data class PairRequest(
        override val requestId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val sessionId: String = PhoneBridgeProtocol.NO_SESSION,
        override val expiresAt: Long? = null,
        override val payload: PairRequestPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_PAIR_REQUEST
    }

    @Serializable
    @SerialName("pair.approved")
    data class PairApproved(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: PairApprovedPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_PAIR_APPROVED
    }

    @Serializable
    @SerialName("pair.denied")
    data class PairDenied(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: PairDeniedPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_PAIR_DENIED
    }

    @Serializable
    @SerialName("pair.expired")
    data class PairExpired(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: EmptyPayload = EmptyPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_PAIR_EXPIRED
    }

    // ----- session.* -----

    @Serializable
    @SerialName("session.ready")
    data class SessionReady(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: SessionReadyPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_SESSION_READY
    }

    @Serializable
    @SerialName("session.revoked")
    data class SessionRevoked(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: SessionRevokedPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_SESSION_REVOKED
    }

    @Serializable
    @SerialName("session.error")
    data class SessionError(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: SessionErrorPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_SESSION_ERROR
    }

    // ----- capture.* -----

    @Serializable
    @SerialName("capture.request")
    data class CaptureRequest(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: CaptureRequestPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_CAPTURE_REQUEST
    }

    @Serializable
    @SerialName("capture.started")
    data class CaptureStarted(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: CaptureStartedPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_CAPTURE_STARTED
    }

    @Serializable
    @SerialName("capture.completed")
    data class CaptureCompleted(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: CaptureCompletedPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_CAPTURE_COMPLETED
    }

    @Serializable
    @SerialName("capture.failed")
    data class CaptureFailed(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: CaptureFailedPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_CAPTURE_FAILED
    }

    // ----- scan.* -----

    @Serializable
    @SerialName("scan.processing")
    data class ScanProcessing(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ScanProcessingPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_SCAN_PROCESSING
    }

    @Serializable
    @SerialName("scan.progress")
    data class ScanProgress(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ScanProgressPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_SCAN_PROGRESS
    }

    @Serializable
    @SerialName("scan.completed")
    data class ScanCompleted(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ScanCompletedPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_SCAN_COMPLETED
    }

    @Serializable
    @SerialName("scan.failed")
    data class ScanFailed(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ScanFailedPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_SCAN_FAILED
    }

    // ----- result.* -----

    @Serializable
    @SerialName("result.show")
    data class ResultShow(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ResultShowPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_RESULT_SHOW
    }

    @Serializable
    @SerialName("result.update")
    data class ResultUpdate(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ResultUpdatePayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_RESULT_UPDATE
    }

    @Serializable
    @SerialName("result.dismiss")
    data class ResultDismiss(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ResultDismissPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_RESULT_DISMISS
    }

    // ----- action.* -----

    @Serializable
    @SerialName("action.save")
    data class ActionSave(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ActionSavePayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_ACTION_SAVE
    }

    @Serializable
    @SerialName("action.open_on_phone")
    data class ActionOpenOnPhone(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ActionOpenOnPhonePayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_ACTION_OPEN_ON_PHONE
    }

    @Serializable
    @SerialName("action.retry")
    data class ActionRetry(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ActionRetryPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_ACTION_RETRY
    }

    @Serializable
    @SerialName("action.cancel")
    data class ActionCancel(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ActionCancelPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_ACTION_CANCEL
    }

    // ----- connection.* -----

    @Serializable
    @SerialName("connection.ping")
    data class ConnectionPing(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ConnectionPingPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_CONNECTION_PING
    }

    @Serializable
    @SerialName("connection.pong")
    data class ConnectionPong(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ConnectionPongPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_CONNECTION_PONG
    }

    @Serializable
    @SerialName("connection.lost")
    data class ConnectionLost(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: ConnectionLostPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_CONNECTION_LOST
    }

    @Serializable
    @SerialName("connection.restored")
    data class ConnectionRestored(
        override val requestId: String,
        override val sessionId: String,
        override val deviceId: String,
        override val timestamp: Long,
        override val protocolVersion: Int = PhoneBridgeProtocol.PROTOCOL_VERSION,
        override val expiresAt: Long? = null,
        override val payload: EmptyPayload = EmptyPayload,
    ) : PhoneBridgeMessage() {
        override val messageType: String get() = PhoneBridgeProtocol.TYPE_CONNECTION_RESTORED
    }
}
