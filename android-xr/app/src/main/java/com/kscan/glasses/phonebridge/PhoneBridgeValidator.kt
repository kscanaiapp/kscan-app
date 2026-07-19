package com.kscan.glasses.phonebridge

import com.kscan.glasses.config.SafeLog
import kotlin.math.abs
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * Stateful validation layer for the versioned phone bridge.
 *
 * Sits between the raw string transport and the runtime: every inbound frame
 * passes [validateIncoming] before any rendering or state use, and every
 * outbound message passes [validateOutgoing] so request/response correlation
 * can be enforced on the replies.
 *
 * Rejections carry ONLY a [BridgeRejectCode] — never payload text, exception
 * messages, or frame content. Rejection logs are code-only via [SafeLog].
 *
 * Validation probe order (fail-closed at the first violation):
 *  1. frame bytes over [PhoneBridgeProtocol.MAX_MESSAGE_BYTES] → PAYLOAD_TOO_LARGE (before any parsing)
 *  2. not valid JSON / not a JSON object → INVALID_MESSAGE
 *  3. messageType missing → INVALID_MESSAGE; unknown value → UNSUPPORTED_MESSAGE_TYPE
 *  4. protocolVersion missing → INVALID_MESSAGE; not this build's version → UNSUPPORTED_PROTOCOL
 *  5. requestId missing or blank → MISSING_REQUEST_ID
 *  6. sessionId field missing → INVALID_MESSAGE
 *  7. full typed decode failure → INVALID_MESSAGE
 *  8. semantic checks (freshness, device, session state, duplicates, correlation, ordering)
 *  9. payload checks (confidence range, thumbnail URL safety)
 */
class PhoneBridgeValidator(
    /** This device's own stable id (the glasses). */
    private val localDeviceId: String,
    /** Wall-clock millis source; injected for determinism in tests. */
    private val clock: () -> Long = System::currentTimeMillis,
) {

    sealed interface ValidationResult {
        data class Accepted(val message: PhoneBridgeMessage) : ValidationResult
        data class Rejected(val code: BridgeRejectCode) : ValidationResult
    }

    /** Session id granted by the currently accepted pair.approved, if any. */
    var currentSessionId: String? = null
        private set

    /** Sender device id learned from pair.approved; enforced on all non-pair frames. */
    var peerDeviceId: String? = null
        private set

    /** Absolute millis at which the current session expires (from pair.approved). */
    var sessionExpiresAt: Long? = null
        private set

    /** True once session.ready has been accepted for the current session. */
    var sessionReady: Boolean = false
        private set

    /** True once session.revoked has been accepted for the current session. */
    var sessionRevoked: Boolean = false
        private set

    /** requestIds of glasses-initiated requests awaiting a correlated reply. */
    private val pendingRequestIds = mutableSetOf<String>()

    /** scanIds with an accepted scan.processing and no terminal event yet. */
    private val processingScanIds = mutableSetOf<String>()

    /** Terminal dedup sets. */
    private val terminalCaptureIds = mutableSetOf<String>()
    private val terminalScanIds = mutableSetOf<String>()
    private val shownResultKeys = mutableSetOf<String>()
    /** resultIds accepted via result.show; required for result.update. */
    private val knownResultIds = mutableSetOf<String>()
    /** Dedup keys for result.update (`resultId:revision`). */
    private val acceptedResultUpdateKeys = mutableSetOf<String>()

    /**
     * Validates an inbound raw frame. Never throws; every failure mode maps to
     * a safe [BridgeRejectCode].
     */
    fun validateIncoming(raw: String): ValidationResult {
        // 1. Byte ceiling first — before parsing or rendering anything.
        if (raw.toByteArray(Charsets.UTF_8).size > PhoneBridgeProtocol.MAX_MESSAGE_BYTES) {
            return reject(BridgeRejectCode.PAYLOAD_TOO_LARGE)
        }

        // 2. Structural parse.
        val obj = PhoneBridgeCodec.probe(raw) ?: return reject(BridgeRejectCode.INVALID_MESSAGE)

        // 3. Discriminator.
        val type = (obj[DISCRIMINATOR] as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?: return reject(BridgeRejectCode.INVALID_MESSAGE)
        if (type !in KNOWN_MESSAGE_TYPES) {
            return reject(BridgeRejectCode.UNSUPPORTED_MESSAGE_TYPE)
        }

        // 4. Protocol version.
        val versionElement = obj["protocolVersion"] ?: return reject(BridgeRejectCode.INVALID_MESSAGE)
        val version = (versionElement as? JsonPrimitive)?.intOrNull
            ?: return reject(BridgeRejectCode.INVALID_MESSAGE)
        if (version != PhoneBridgeProtocol.PROTOCOL_VERSION) {
            return reject(BridgeRejectCode.UNSUPPORTED_PROTOCOL)
        }

        // 5. requestId.
        val requestId = (obj["requestId"] as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
        if (requestId.isNullOrBlank()) {
            return reject(BridgeRejectCode.MISSING_REQUEST_ID)
        }

        // 6. sessionId field presence (emptiness rules are semantic, below).
        val sessionIdElement = obj["sessionId"] ?: return reject(BridgeRejectCode.INVALID_MESSAGE)
        if ((sessionIdElement as? JsonPrimitive)?.isString != true) {
            return reject(BridgeRejectCode.INVALID_MESSAGE)
        }

        // 7. Full typed decode.
        val message = runCatching { PhoneBridgeCodec.decode(raw) }.getOrNull()
            ?: return reject(BridgeRejectCode.INVALID_MESSAGE)

        // 8. Semantic checks.
        semanticRejection(message)?.let { return reject(it) }

        // 9. Payload checks.
        payloadRejection(message)?.let { return reject(it) }

        onAccepted(message)
        return ValidationResult.Accepted(message)
    }

    /**
     * Encodes an outbound message and registers correlation state for the
     * glasses-initiated request families (pair.request, capture.request).
     *
     * @throws PhoneBridgeMessageTooLargeException if the frame exceeds the ceiling.
     */
    fun validateOutgoing(message: PhoneBridgeMessage): String {
        val frame = PhoneBridgeCodec.encode(message)
        when (message) {
            is PhoneBridgeMessage.PairRequest,
            is PhoneBridgeMessage.CaptureRequest,
            -> pendingRequestIds.add(message.requestId)
            else -> Unit
        }
        return frame
    }

    // ----- semantic checks (step 8) -----

    private fun semanticRejection(message: PhoneBridgeMessage): BridgeRejectCode? {
        val now = clock()

        // Freshness: clock skew in either direction, and message-level expiry.
        if (abs(now - message.timestamp) > PhoneBridgeProtocol.TIMESTAMP_TOLERANCE_MS) {
            return BridgeRejectCode.STALE_MESSAGE
        }
        message.expiresAt?.let { if (it < now) return BridgeRejectCode.STALE_MESSAGE }

        val isPairReply = message is PhoneBridgeMessage.PairApproved ||
            message is PhoneBridgeMessage.PairDenied ||
            message is PhoneBridgeMessage.PairExpired
        val isPairFamily = message is PhoneBridgeMessage.PairRequest || isPairReply

        if (message is PhoneBridgeMessage.PairRequest) {
            // Empty sessionId is allowed ONLY here — no session exists yet.
            if (message.sessionId != PhoneBridgeProtocol.NO_SESSION) {
                return BridgeRejectCode.INVALID_MESSAGE
            }
        }

        if (isPairReply) {
            // An active (non-revoked) session cannot be silently replaced by a
            // correlated pair.* reply — revoke first, then re-pair.
            if (currentSessionId != null && !sessionRevoked) {
                return BridgeRejectCode.INVALID_MESSAGE
            }
            // After a peer is learned, pair replies must still come from that
            // peer until the session is revoked (re-pair may introduce a new peer).
            val peer = peerDeviceId
            if (peer != null && !sessionRevoked && message.deviceId != peer) {
                return BridgeRejectCode.WRONG_DEVICE
            }
            if (message is PhoneBridgeMessage.PairApproved) {
                val expiresAt = message.payload.sessionExpiresAt
                if (expiresAt <= message.timestamp) {
                    return BridgeRejectCode.INVALID_MESSAGE
                }
                if (expiresAt - message.timestamp > PhoneBridgeProtocol.MAX_SESSION_DURATION_MS) {
                    return BridgeRejectCode.INVALID_MESSAGE
                }
            }
        }

        if (!isPairFamily) {
            // Sender identity once paired.
            val peer = peerDeviceId
            if (peer != null && message.deviceId != peer) {
                return BridgeRejectCode.WRONG_DEVICE
            }

            // Session state.
            if (message.sessionId.isEmpty()) {
                return BridgeRejectCode.INVALID_MESSAGE
            }
            val current = currentSessionId
            if (current == null || message.sessionId != current) {
                return BridgeRejectCode.SESSION_NOT_READY
            }
            if (sessionRevoked) {
                return BridgeRejectCode.SESSION_REVOKED
            }
            sessionExpiresAt?.let { if (now > it) return BridgeRejectCode.SESSION_EXPIRED }

            // Actions additionally require the session.ready handshake.
            val isAction = message is PhoneBridgeMessage.ActionSave ||
                message is PhoneBridgeMessage.ActionOpenOnPhone ||
                message is PhoneBridgeMessage.ActionRetry ||
                message is PhoneBridgeMessage.ActionCancel
            if (isAction && !sessionReady) {
                return BridgeRejectCode.SESSION_NOT_READY
            }
        }

        // Terminal duplicates (read-only here; recorded in onAccepted).
        when (message) {
            is PhoneBridgeMessage.CaptureCompleted ->
                if (message.payload.captureId in terminalCaptureIds) return BridgeRejectCode.DUPLICATE_EVENT
            is PhoneBridgeMessage.CaptureFailed ->
                if (message.payload.captureId in terminalCaptureIds) return BridgeRejectCode.DUPLICATE_EVENT
            is PhoneBridgeMessage.ScanCompleted ->
                if (message.payload.scanId in terminalScanIds) return BridgeRejectCode.DUPLICATE_EVENT
            is PhoneBridgeMessage.ScanFailed ->
                if (message.payload.scanId in terminalScanIds) return BridgeRejectCode.DUPLICATE_EVENT
            is PhoneBridgeMessage.ResultShow ->
                if (resultShowKey(message) in shownResultKeys) return BridgeRejectCode.DUPLICATE_EVENT
            is PhoneBridgeMessage.ResultUpdate -> {
                val resultId = message.payload.result.resultId
                if (resultId !in knownResultIds) return BridgeRejectCode.INVALID_MESSAGE
                if (resultUpdateKey(message) in acceptedResultUpdateKeys) {
                    return BridgeRejectCode.DUPLICATE_EVENT
                }
            }
            else -> Unit
        }

        // Correlation: replies to glasses-initiated requests must echo a
        // requestId that is currently pending.
        val needsCorrelation = message is PhoneBridgeMessage.PairApproved ||
            message is PhoneBridgeMessage.PairDenied ||
            message is PhoneBridgeMessage.PairExpired ||
            message is PhoneBridgeMessage.CaptureStarted ||
            message is PhoneBridgeMessage.CaptureCompleted ||
            message is PhoneBridgeMessage.CaptureFailed
        if (needsCorrelation && message.requestId !in pendingRequestIds) {
            return BridgeRejectCode.INVALID_MESSAGE
        }

        // Ordering: a scan terminal event requires a prior scan.processing.
        when (message) {
            is PhoneBridgeMessage.ScanCompleted ->
                if (message.payload.scanId !in processingScanIds) return BridgeRejectCode.INVALID_MESSAGE
            is PhoneBridgeMessage.ScanFailed ->
                if (message.payload.scanId !in processingScanIds) return BridgeRejectCode.INVALID_MESSAGE
            else -> Unit
        }

        return null
    }

    // ----- payload checks (step 9) -----

    private fun payloadRejection(message: PhoneBridgeMessage): BridgeRejectCode? {
        val result = when (message) {
            is PhoneBridgeMessage.ResultShow -> message.payload.result
            is PhoneBridgeMessage.ResultUpdate -> message.payload.result
            else -> null
        } ?: return null

        if (result.confidence < 0f || result.confidence > 1f) {
            return BridgeRejectCode.INVALID_MESSAGE
        }
        for (product in result.products) {
            val url = product.thumbnailUrl ?: continue
            if (!url.startsWith("https://")) return BridgeRejectCode.INVALID_MESSAGE
            if (url.contains("data:", ignoreCase = true)) return BridgeRejectCode.INVALID_MESSAGE
            if (hasTokenishQueryParam(url)) return BridgeRejectCode.INVALID_MESSAGE
        }
        return null
    }

    /** Query params that can carry credentials are forbidden on the bridge. */
    private fun hasTokenishQueryParam(url: String): Boolean {
        val query = url.substringAfter('?', missingDelimiterValue = "")
        if (query.isEmpty()) return false
        return query.split('&').any { part ->
            part.substringBefore('=').lowercase() in TOKENISH_QUERY_PARAMS
        }
    }

    // ----- accepted-message state hooks -----

    private fun onAccepted(message: PhoneBridgeMessage) {
        when (message) {
            is PhoneBridgeMessage.PairApproved -> {
                currentSessionId = message.sessionId
                peerDeviceId = message.deviceId
                sessionExpiresAt = message.payload.sessionExpiresAt
                sessionReady = false
                sessionRevoked = false
                pendingRequestIds.remove(message.requestId)
                // Session-scoped transcript state resets with the new session.
                processingScanIds.clear()
                terminalCaptureIds.clear()
                terminalScanIds.clear()
                shownResultKeys.clear()
                knownResultIds.clear()
                acceptedResultUpdateKeys.clear()
            }
            is PhoneBridgeMessage.PairDenied,
            is PhoneBridgeMessage.PairExpired,
            -> pendingRequestIds.remove(message.requestId)
            is PhoneBridgeMessage.SessionReady -> sessionReady = true
            is PhoneBridgeMessage.SessionRevoked -> {
                sessionReady = false
                sessionRevoked = true
                pendingRequestIds.clear()
                knownResultIds.clear()
                acceptedResultUpdateKeys.clear()
            }
            is PhoneBridgeMessage.CaptureStarted -> Unit // requestId stays pending until terminal
            is PhoneBridgeMessage.CaptureCompleted -> {
                pendingRequestIds.remove(message.requestId)
                terminalCaptureIds.add(message.payload.captureId)
            }
            is PhoneBridgeMessage.CaptureFailed -> {
                pendingRequestIds.remove(message.requestId)
                terminalCaptureIds.add(message.payload.captureId)
            }
            is PhoneBridgeMessage.ScanProcessing -> processingScanIds.add(message.payload.scanId)
            is PhoneBridgeMessage.ScanCompleted -> {
                processingScanIds.remove(message.payload.scanId)
                terminalScanIds.add(message.payload.scanId)
            }
            is PhoneBridgeMessage.ScanFailed -> {
                processingScanIds.remove(message.payload.scanId)
                terminalScanIds.add(message.payload.scanId)
            }
            is PhoneBridgeMessage.ResultShow -> {
                shownResultKeys.add(resultShowKey(message))
                knownResultIds.add(message.payload.result.resultId)
            }
            is PhoneBridgeMessage.ResultUpdate -> {
                knownResultIds.add(message.payload.result.resultId)
                acceptedResultUpdateKeys.add(resultUpdateKey(message))
            }
            else -> Unit
        }
    }

    private fun resultShowKey(message: PhoneBridgeMessage.ResultShow): String =
        message.requestId + ":" + message.payload.result.resultId

    private fun resultUpdateKey(message: PhoneBridgeMessage.ResultUpdate): String =
        message.payload.result.resultId + ":" + message.payload.revision

    private fun reject(code: BridgeRejectCode): ValidationResult.Rejected {
        // Code-only text: never frame bytes, payloads, or exception messages.
        // (SafeLog may drop codes whose names trip its payload filter; that
        // fail-closed behavior is intentional.)
        SafeLog.w(TAG, "bridge_reject:" + code.name)
        return ValidationResult.Rejected(code)
    }

    companion object {
        private const val TAG = "PhoneBridge"
        private const val DISCRIMINATOR = "messageType"

        private val KNOWN_MESSAGE_TYPES: Set<String> = setOf(
            PhoneBridgeProtocol.TYPE_PAIR_REQUEST,
            PhoneBridgeProtocol.TYPE_PAIR_APPROVED,
            PhoneBridgeProtocol.TYPE_PAIR_DENIED,
            PhoneBridgeProtocol.TYPE_PAIR_EXPIRED,
            PhoneBridgeProtocol.TYPE_SESSION_READY,
            PhoneBridgeProtocol.TYPE_SESSION_REVOKED,
            PhoneBridgeProtocol.TYPE_SESSION_ERROR,
            PhoneBridgeProtocol.TYPE_CAPTURE_REQUEST,
            PhoneBridgeProtocol.TYPE_CAPTURE_STARTED,
            PhoneBridgeProtocol.TYPE_CAPTURE_COMPLETED,
            PhoneBridgeProtocol.TYPE_CAPTURE_FAILED,
            PhoneBridgeProtocol.TYPE_SCAN_PROCESSING,
            PhoneBridgeProtocol.TYPE_SCAN_PROGRESS,
            PhoneBridgeProtocol.TYPE_SCAN_COMPLETED,
            PhoneBridgeProtocol.TYPE_SCAN_FAILED,
            PhoneBridgeProtocol.TYPE_RESULT_SHOW,
            PhoneBridgeProtocol.TYPE_RESULT_UPDATE,
            PhoneBridgeProtocol.TYPE_RESULT_DISMISS,
            PhoneBridgeProtocol.TYPE_ACTION_SAVE,
            PhoneBridgeProtocol.TYPE_ACTION_OPEN_ON_PHONE,
            PhoneBridgeProtocol.TYPE_ACTION_RETRY,
            PhoneBridgeProtocol.TYPE_ACTION_CANCEL,
            PhoneBridgeProtocol.TYPE_CONNECTION_PING,
            PhoneBridgeProtocol.TYPE_CONNECTION_PONG,
            PhoneBridgeProtocol.TYPE_CONNECTION_LOST,
            PhoneBridgeProtocol.TYPE_CONNECTION_RESTORED,
        )

        private val TOKENISH_QUERY_PARAMS: Set<String> = setOf(
            "token",
            "access_token",
            "auth_token",
            "auth",
            "signature",
            "sig",
            "jwt",
            "key",
            "api_key",
            "apikey",
            "session",
            "session_id",
        )
    }
}
