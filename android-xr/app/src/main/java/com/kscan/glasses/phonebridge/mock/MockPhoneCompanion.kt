package com.kscan.glasses.phonebridge.mock

import com.kscan.glasses.phonebridge.CaptureCompletedPayload
import com.kscan.glasses.phonebridge.CaptureStartedPayload
import com.kscan.glasses.phonebridge.ConnectionLostPayload
import com.kscan.glasses.phonebridge.ConnectionLostReason
import com.kscan.glasses.phonebridge.ConnectionPingPayload
import com.kscan.glasses.phonebridge.ConnectionPongPayload
import com.kscan.glasses.phonebridge.PairApprovedPayload
import com.kscan.glasses.phonebridge.PairDeniedPayload
import com.kscan.glasses.phonebridge.PairDenyReason
import com.kscan.glasses.phonebridge.PhoneBridgeCodec
import com.kscan.glasses.phonebridge.PhoneBridgeMessage
import com.kscan.glasses.phonebridge.PhoneBridgeProtocol
import com.kscan.glasses.phonebridge.PhoneBridgeTransport
import com.kscan.glasses.phonebridge.ResultAction
import com.kscan.glasses.phonebridge.ResultPayload
import com.kscan.glasses.phonebridge.ResultProduct
import com.kscan.glasses.phonebridge.ResultShowPayload
import com.kscan.glasses.phonebridge.ResultUpdatePayload
import com.kscan.glasses.phonebridge.RetailGroup
import com.kscan.glasses.phonebridge.ScanCompletedPayload
import com.kscan.glasses.phonebridge.ScanFailedPayload
import com.kscan.glasses.phonebridge.ScanProcessingPayload
import com.kscan.glasses.phonebridge.ScanProgressPayload
import com.kscan.glasses.phonebridge.ScanStage
import com.kscan.glasses.phonebridge.ScanStatus
import com.kscan.glasses.phonebridge.SessionErrorPayload
import com.kscan.glasses.phonebridge.SessionReadyPayload
import com.kscan.glasses.phonebridge.SessionRevokeReason
import com.kscan.glasses.phonebridge.SessionRevokedPayload
import com.kscan.glasses.scan.ScanErrorCode

/**
 * Deterministic mock phone companion for the versioned phone bridge.
 *
 * Determinism: wall-clock time comes from an injected [clock], and every id
 * is sequential ([nextId]). No randomness, no real time, no sleeping.
 *
 * The mock emits raw frames over a [PhoneBridgeTransport]; tests drive it by
 * feeding glasses-originated frames to [handleIncoming] and by calling the
 * explicit `send*` methods for phone-initiated lifecycles. Setting
 * [responsive] to false simulates a lost link: every emit is dropped.
 */
class MockPhoneCompanion(
    private val transport: PhoneBridgeTransport,
    private val clock: () -> Long,
    val deviceId: String = DEFAULT_DEVICE_ID,
    var pairBehavior: PairBehavior = PairBehavior.APPROVE,
    private val sessionTtlMs: Long = DEFAULT_SESSION_TTL_MS,
) {

    /** How the mock answers a pair.request. */
    enum class PairBehavior {
        /** pair.approved with a fresh session id. */
        APPROVE,

        /** pair.denied with USER_REJECTED. */
        DENY,

        /** No reply until [expireHeldPairRequest] is called (pairing timeout). */
        HOLD_UNTIL_EXPIRY,
    }

    /** When false, every outbound emit is dropped (link lost / app dead). */
    var responsive: Boolean = true

    private var idCounter = 0

    /** Sequential id factory: next("req") → req-1, req-2, ... */
    fun nextId(prefix: String): String = "$prefix-${++idCounter}"

    private var grantedSessionId: String? = null
    private var heldPairRequest: PhoneBridgeMessage.PairRequest? = null
    private var revoked = false
    private var resultRevision = 0

    // ----- inbound handling (glasses → phone) -----

    /**
     * Handles one raw frame from the glasses side, answering per configuration.
     * Malformed frames are ignored — the glasses-side validator owns rejection.
     */
    suspend fun handleIncoming(raw: String) {
        if (!responsive) return
        val message = runCatching { PhoneBridgeCodec.decode(raw) }.getOrNull() ?: return
        when (message) {
            is PhoneBridgeMessage.PairRequest -> when (pairBehavior) {
                PairBehavior.APPROVE -> approvePairing(message)
                PairBehavior.DENY -> denyPairing(message)
                PairBehavior.HOLD_UNTIL_EXPIRY -> heldPairRequest = message
            }
            is PhoneBridgeMessage.CaptureRequest -> sendCaptureSequence(message)
            is PhoneBridgeMessage.ActionSave -> ackSave(message)
            is PhoneBridgeMessage.ConnectionPing -> sendPong(message)
            else -> Unit
        }
    }

    // ----- pairing -----

    suspend fun approvePairing(request: PhoneBridgeMessage.PairRequest) {
        val sessionId = nextId("sess")
        grantedSessionId = sessionId
        revoked = false
        emit(
            PhoneBridgeMessage.PairApproved(
                requestId = request.requestId,
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = PairApprovedPayload(sessionExpiresAt = clock() + sessionTtlMs),
            ),
        )
    }

    suspend fun denyPairing(
        request: PhoneBridgeMessage.PairRequest,
        reason: PairDenyReason = PairDenyReason.USER_REJECTED,
    ) {
        emit(
            PhoneBridgeMessage.PairDenied(
                requestId = request.requestId,
                sessionId = PhoneBridgeProtocol.NO_SESSION,
                deviceId = deviceId,
                timestamp = clock(),
                payload = PairDeniedPayload(reason = reason),
            ),
        )
    }

    /** Sends pair.expired for a held pair.request (pairing timeout path). */
    suspend fun expireHeldPairRequest() {
        val held = heldPairRequest ?: return
        heldPairRequest = null
        emit(
            PhoneBridgeMessage.PairExpired(
                requestId = held.requestId,
                sessionId = PhoneBridgeProtocol.NO_SESSION,
                deviceId = deviceId,
                timestamp = clock(),
            ),
        )
    }

    // ----- session -----

    suspend fun sendSessionReady(
        phoneAppVersion: String = "1.0.0-mock",
        features: List<String> = listOf("scan", "save", "open_on_phone"),
    ) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.SessionReady(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = SessionReadyPayload(phoneAppVersion = phoneAppVersion, features = features),
            ),
        )
    }

    suspend fun revokeSession(reason: SessionRevokeReason = SessionRevokeReason.USER_REVOKED) {
        val sessionId = grantedSessionId ?: return
        revoked = true
        emit(
            PhoneBridgeMessage.SessionRevoked(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = SessionRevokedPayload(reason = reason),
            ),
        )
    }

    suspend fun sendSessionError(code: String, recoverable: Boolean = true) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.SessionError(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = SessionErrorPayload(code = code, recoverable = recoverable),
            ),
        )
    }

    // ----- capture -----

    /** capture.started followed by capture.completed with an opaque reference. */
    suspend fun sendCaptureSequence(request: PhoneBridgeMessage.CaptureRequest) {
        val sessionId = grantedSessionId ?: return
        val captureId = nextId("cap")
        emit(
            PhoneBridgeMessage.CaptureStarted(
                requestId = request.requestId,
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = CaptureStartedPayload(captureId = captureId),
            ),
        )
        emit(
            PhoneBridgeMessage.CaptureCompleted(
                requestId = request.requestId,
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                // Opaque phone-side reference only — never image data.
                payload = CaptureCompletedPayload(captureId = captureId, captureRef = "ref-$captureId"),
            ),
        )
    }

    // ----- scan -----

    suspend fun sendScanProcessing(scanId: String) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ScanProcessing(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ScanProcessingPayload(scanId = scanId),
            ),
        )
    }

    suspend fun sendScanProgress(scanId: String, stage: ScanStage, percent: Int) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ScanProgress(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ScanProgressPayload(scanId = scanId, stage = stage, percent = percent),
            ),
        )
    }

    suspend fun sendScanCompleted(scanId: String, resultId: String) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ScanCompleted(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ScanCompletedPayload(scanId = scanId, resultId = resultId),
            ),
        )
    }

    suspend fun sendScanFailed(scanId: String, code: ScanErrorCode) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ScanFailed(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ScanFailedPayload(scanId = scanId, code = code),
            ),
        )
    }

    /** Full happy-path scan: processing → 3 progress stages → completed. */
    suspend fun sendScanSequence(scanId: String, resultId: String) {
        sendScanProcessing(scanId)
        sendScanProgress(scanId, ScanStage.PRIVACY_PROCESSING, 25)
        sendScanProgress(scanId, ScanStage.ANALYZING, 60)
        sendScanProgress(scanId, ScanStage.MATCHING, 90)
        sendScanCompleted(scanId, resultId)
    }

    /** Sends scan.completed twice for the same scanId (duplicate-terminal path). */
    suspend fun sendDuplicateScanCompleted(scanId: String, resultId: String) {
        sendScanProcessing(scanId)
        sendScanCompleted(scanId, resultId)
        sendScanCompleted(scanId, resultId)
    }

    // ----- result -----

    /** Canonical result fixture: structured fields only, HTTPS thumbnails. */
    fun buildResult(resultId: String, summaryPadding: Int = 0): ResultPayload = ResultPayload(
        resultId = resultId,
        summary = "Vintage black leather jacket" + "x".repeat(summaryPadding),
        confidence = 0.93f,
        products = listOf(
            ResultProduct(
                title = "Leather Biker Jacket",
                brand = "Saint Laurent",
                price = "2990.00",
                currency = "USD",
                group = RetailGroup.RETAIL,
                thumbnailUrl = "https://cdn.example.com/thumbs/jacket-retail.jpg",
            ),
            ResultProduct(
                title = "Pre-owned Leather Jacket",
                brand = "Schott",
                price = "420.00",
                currency = "USD",
                group = RetailGroup.RESALE,
                thumbnailUrl = "https://cdn.example.com/thumbs/jacket-resale.jpg",
            ),
        ),
        availableActions = listOf(ResultAction.SAVE, ResultAction.OPEN_ON_PHONE),
        scanStatus = ScanStatus.COMPLETED,
    )

    suspend fun sendResultShow(resultId: String) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ResultShow(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ResultShowPayload(result = buildResult(resultId)),
            ),
        )
    }

    /**
     * Sends a result.show frame padded past the 64 KiB wire ceiling, bypassing
     * the encoder ceiling. The validator must reject it PAYLOAD_TOO_LARGE.
     */
    suspend fun sendOversizedResultShow() {
        val sessionId = grantedSessionId ?: return
        val message = PhoneBridgeMessage.ResultShow(
            requestId = nextId("req"),
            sessionId = sessionId,
            deviceId = deviceId,
            timestamp = clock(),
            payload = ResultShowPayload(
                result = buildResult(nextId("res"), summaryPadding = PhoneBridgeProtocol.MAX_MESSAGE_BYTES),
            ),
        )
        emitRaw(PhoneBridgeCodec.encode(message, enforceCeiling = false))
    }

    /** Action ack: save → result.update with a bumped revision. */
    suspend fun ackSave(action: PhoneBridgeMessage.ActionSave) {
        val sessionId = grantedSessionId ?: return
        if (revoked) {
            emit(
                PhoneBridgeMessage.SessionError(
                    requestId = nextId("req"),
                    sessionId = sessionId,
                    deviceId = deviceId,
                    timestamp = clock(),
                    payload = SessionErrorPayload(code = "SESSION_REVOKED", recoverable = false),
                ),
            )
            return
        }
        resultRevision += 1
        emit(
            PhoneBridgeMessage.ResultUpdate(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ResultUpdatePayload(
                    result = buildResult(action.payload.resultId),
                    revision = resultRevision,
                ),
            ),
        )
    }

    // ----- connection -----

    suspend fun sendPong(ping: PhoneBridgeMessage.ConnectionPing) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ConnectionPong(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ConnectionPongPayload(nonce = ping.payload.nonce),
            ),
        )
    }

    suspend fun sendPing(nonce: String) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ConnectionPing(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ConnectionPingPayload(nonce = nonce),
            ),
        )
    }

    suspend fun sendConnectionLost(reason: ConnectionLostReason = ConnectionLostReason.TRANSPORT_LOST) {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ConnectionLost(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
                payload = ConnectionLostPayload(reason = reason),
            ),
        )
    }

    suspend fun sendConnectionRestored() {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.ConnectionRestored(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock(),
            ),
        )
    }

    // ----- hostile / malformed emitters (validator exercise) -----

    /** Any envelope-valid frame whose timestamp is far outside the tolerance. */
    suspend fun sendStaleSessionError() {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.SessionError(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = deviceId,
                timestamp = clock() - PhoneBridgeProtocol.TIMESTAMP_TOLERANCE_MS * 2,
                payload = SessionErrorPayload(code = "UNKNOWN_SAFE_ERROR", recoverable = true),
            ),
        )
    }

    /** Envelope-valid frame sent from a device id that is not the paired peer. */
    suspend fun sendWrongDeviceSessionError(impostorDeviceId: String = "phone-mock-impostor") {
        val sessionId = grantedSessionId ?: return
        emit(
            PhoneBridgeMessage.SessionError(
                requestId = nextId("req"),
                sessionId = sessionId,
                deviceId = impostorDeviceId,
                timestamp = clock(),
                payload = SessionErrorPayload(code = "UNKNOWN_SAFE_ERROR", recoverable = true),
            ),
        )
    }

    // ----- emit plumbing -----

    private suspend fun emit(message: PhoneBridgeMessage) {
        if (!responsive) return
        transport.send(PhoneBridgeCodec.encode(message))
    }

    private suspend fun emitRaw(frame: String) {
        if (!responsive) return
        transport.send(frame)
    }

    companion object {
        const val DEFAULT_DEVICE_ID: String = "phone-mock-1"
        const val DEFAULT_SESSION_TTL_MS: Long = 30 * 60 * 1_000L
    }
}
