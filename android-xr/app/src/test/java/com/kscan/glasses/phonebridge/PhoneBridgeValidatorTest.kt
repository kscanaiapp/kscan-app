package com.kscan.glasses.phonebridge

import com.kscan.glasses.phonebridge.PhoneBridgeValidator.ValidationResult
import com.kscan.glasses.scan.ScanErrorCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Validation-layer coverage: every required rejection path maps to its stable
 * [BridgeRejectCode], and a full happy-path exchange across all seven families
 * is accepted in order.
 */
class PhoneBridgeValidatorTest {

    private companion object {
        const val GLASSES_ID = "glasses-1"
        const val PHONE_ID = "phone-1"
        const val SESSION_ID = "sess-1"
        const val T0 = 1_700_000_000_000L

        fun sampleResult(resultId: String = "res-1") = ResultPayload(
            resultId = resultId,
            summary = "Vintage black leather jacket",
            confidence = 0.5f,
            products = emptyList(),
            availableActions = listOf(ResultAction.SAVE),
            scanStatus = ScanStatus.COMPLETED,
        )

        fun assertAccepted(result: ValidationResult) {
            assertTrue(
                "expected Accepted, got $result",
                result is ValidationResult.Accepted,
            )
        }

        fun assertRejected(result: ValidationResult, code: BridgeRejectCode) {
            assertEquals(ValidationResult.Rejected(code), result)
        }
    }

    /** A validator with an injected clock plus message builders bound to it. */
    private class Fixture {
        var now = T0
        val validator = PhoneBridgeValidator(GLASSES_ID) { now }

        fun validate(message: PhoneBridgeMessage): ValidationResult =
            validator.validateIncoming(PhoneBridgeCodec.encode(message))

        fun validateRaw(raw: String): ValidationResult = validator.validateIncoming(raw)

        fun pairRequest(requestId: String) = PhoneBridgeMessage.PairRequest(
            requestId = requestId, deviceId = GLASSES_ID, timestamp = now,
            payload = PairRequestPayload(model = "KScan Glasses", appVersion = "1.0.0"),
        )

        /** Registers a pending pair.request and accepts its pair.approved reply. */
        fun pair(pairRequestId: String = "glasses-req-1", sessionId: String = SESSION_ID, ttlMs: Long = 30 * 60_000L) {
            validator.validateOutgoing(pairRequest(pairRequestId))
            val approved = PhoneBridgeMessage.PairApproved(
                requestId = pairRequestId, sessionId = sessionId, deviceId = PHONE_ID, timestamp = now,
                payload = PairApprovedPayload(sessionExpiresAt = now + ttlMs),
            )
            assertAccepted(validate(approved))
        }

        fun ready() {
            assertAccepted(validate(sessionReady()))
        }

        fun pairAndReady() {
            pair()
            ready()
        }

        fun sessionReady() = PhoneBridgeMessage.SessionReady(
            requestId = "phone-req-ready", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = now,
            payload = SessionReadyPayload(phoneAppVersion = "1.0.0"),
        )

        fun sessionError(requestId: String = "phone-req-err") = PhoneBridgeMessage.SessionError(
            requestId = requestId, sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = now,
            payload = SessionErrorPayload(code = "UNKNOWN_SAFE_ERROR", recoverable = true),
        )

        fun actionSave(requestId: String = "glasses-act-1") = PhoneBridgeMessage.ActionSave(
            requestId = requestId, sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = now,
            payload = ActionSavePayload(resultId = "res-1"),
        )

        fun scanProcessing(scanId: String, requestId: String = "phone-req-proc") = PhoneBridgeMessage.ScanProcessing(
            requestId = requestId, sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = now,
            payload = ScanProcessingPayload(scanId = scanId),
        )

        fun scanCompleted(scanId: String, requestId: String) = PhoneBridgeMessage.ScanCompleted(
            requestId = requestId, sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = now,
            payload = ScanCompletedPayload(scanId = scanId, resultId = "res-1"),
        )

        fun captureRequest(requestId: String) = PhoneBridgeMessage.CaptureRequest(
            requestId = requestId, sessionId = SESSION_ID, deviceId = GLASSES_ID, timestamp = now,
            payload = CaptureRequestPayload(preference = CapturePreference.AUTO),
        )

        fun resultShow(requestId: String = "phone-req-show", resultId: String = "res-1", result: ResultPayload = sampleResult(resultId)) =
            PhoneBridgeMessage.ResultShow(
                requestId = requestId, sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = now,
                payload = ResultShowPayload(result = result),
            )
    }

    // ----- happy path: every family accepted -----

    @Test
    fun `valid exchange across all seven families is accepted`() {
        val f = Fixture()

        // pair.* — pair.request may arrive with an empty sessionId.
        assertAccepted(f.validate(f.pairRequest("glasses-req-0")))
        f.pair()
        f.validator.validateOutgoing(f.pairRequest("glasses-req-2"))
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.PairDenied(
                    requestId = "glasses-req-2", sessionId = PhoneBridgeProtocol.NO_SESSION,
                    deviceId = PHONE_ID, timestamp = f.now,
                    payload = PairDeniedPayload(reason = PairDenyReason.BUSY),
                ),
            ),
        )
        f.validator.validateOutgoing(f.pairRequest("glasses-req-3"))
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.PairExpired(
                    requestId = "glasses-req-3", sessionId = PhoneBridgeProtocol.NO_SESSION,
                    deviceId = PHONE_ID, timestamp = f.now,
                ),
            ),
        )

        // session.*
        f.ready()
        assertAccepted(f.validate(f.sessionError()))

        // capture.* — replies correlate to the registered request.
        f.validator.validateOutgoing(f.captureRequest("glasses-cap-1"))
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.CaptureRequest(
                    requestId = "glasses-cap-echo", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = CaptureRequestPayload(preference = CapturePreference.PHONE),
                ),
            ),
        )
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.CaptureStarted(
                    requestId = "glasses-cap-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = CaptureStartedPayload(captureId = "cap-1"),
                ),
            ),
        )
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.CaptureCompleted(
                    requestId = "glasses-cap-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = CaptureCompletedPayload(captureId = "cap-1", captureRef = "ref-cap-1"),
                ),
            ),
        )
        f.validator.validateOutgoing(f.captureRequest("glasses-cap-2"))
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.CaptureFailed(
                    requestId = "glasses-cap-2", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = CaptureFailedPayload(captureId = "cap-2", code = ScanErrorCode.CAPTURE_UNAVAILABLE),
                ),
            ),
        )

        // scan.* — terminals require a prior scan.processing.
        assertAccepted(f.validate(f.scanProcessing("scan-1")))
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ScanProgress(
                    requestId = "phone-req-prog", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ScanProgressPayload(scanId = "scan-1", stage = ScanStage.ANALYZING, percent = 60),
                ),
            ),
        )
        assertAccepted(f.validate(f.scanCompleted("scan-1", requestId = "phone-req-done")))
        assertAccepted(f.validate(f.scanProcessing("scan-2", requestId = "phone-req-proc-2")))
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ScanFailed(
                    requestId = "phone-req-fail", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ScanFailedPayload(scanId = "scan-2", code = ScanErrorCode.BACKEND_UNAVAILABLE),
                ),
            ),
        )

        // result.*
        assertAccepted(f.validate(f.resultShow()))
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ResultUpdate(
                    requestId = "phone-req-upd", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ResultUpdatePayload(result = sampleResult(), revision = 1),
                ),
            ),
        )
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ResultDismiss(
                    requestId = "phone-req-dis", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ResultDismissPayload(resultId = "res-1"),
                ),
            ),
        )

        // action.* — session.ready has been accepted above.
        assertAccepted(f.validate(f.actionSave()))
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ActionOpenOnPhone(
                    requestId = "glasses-act-2", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ActionOpenOnPhonePayload(resultId = "res-1"),
                ),
            ),
        )
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ActionRetry(
                    requestId = "glasses-act-3", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ActionRetryPayload(scanId = "scan-2"),
                ),
            ),
        )
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ActionCancel(
                    requestId = "glasses-act-4", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ActionCancelPayload(scanId = "scan-2"),
                ),
            ),
        )

        // connection.*
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ConnectionPing(
                    requestId = "glasses-ping-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ConnectionPingPayload(nonce = "n-1"),
                ),
            ),
        )
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ConnectionPong(
                    requestId = "phone-pong-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ConnectionPongPayload(nonce = "n-1"),
                ),
            ),
        )
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ConnectionLost(
                    requestId = "phone-lost-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = ConnectionLostPayload(reason = ConnectionLostReason.TRANSPORT_LOST),
                ),
            ),
        )
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.ConnectionRestored(
                    requestId = "phone-rest-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                ),
            ),
        )

        // session.revoked last: it closes the session for later traffic.
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.SessionRevoked(
                    requestId = "phone-rev-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = SessionRevokedPayload(reason = SessionRevokeReason.USER_REVOKED),
                ),
            ),
        )
    }

    // ----- rejection cases -----

    @Test
    fun `unknown protocol version is rejected`() {
        val f = Fixture()
        val message = PhoneBridgeMessage.PairRequest(
            requestId = "glasses-req-1", deviceId = GLASSES_ID, timestamp = f.now,
            protocolVersion = 2,
            payload = PairRequestPayload(model = "KScan Glasses", appVersion = "1.0.0"),
        )
        assertRejected(f.validate(message), BridgeRejectCode.UNSUPPORTED_PROTOCOL)
    }

    @Test
    fun `missing requestId is rejected`() {
        val f = Fixture()
        val raw = """
            {"messageType":"connection.ping","protocolVersion":1,"sessionId":"s",
             "deviceId":"d","timestamp":$T0,"payload":{"nonce":"n"}}
        """.trimIndent()
        assertRejected(f.validateRaw(raw), BridgeRejectCode.MISSING_REQUEST_ID)
    }

    @Test
    fun `blank requestId is rejected`() {
        val f = Fixture()
        val raw = """
            {"messageType":"connection.ping","protocolVersion":1,"requestId":"  ","sessionId":"s",
             "deviceId":"d","timestamp":$T0,"payload":{"nonce":"n"}}
        """.trimIndent()
        assertRejected(f.validateRaw(raw), BridgeRejectCode.MISSING_REQUEST_ID)
    }

    @Test
    fun `missing sessionId is rejected`() {
        val f = Fixture()
        val raw = """
            {"messageType":"connection.ping","protocolVersion":1,"requestId":"r-1",
             "deviceId":"d","timestamp":$T0,"payload":{"nonce":"n"}}
        """.trimIndent()
        assertRejected(f.validateRaw(raw), BridgeRejectCode.INVALID_MESSAGE)
    }

    @Test
    fun `non-empty sessionId on pair request is rejected`() {
        val f = Fixture()
        val message = PhoneBridgeMessage.PairRequest(
            requestId = "glasses-req-1", deviceId = GLASSES_ID, timestamp = f.now,
            sessionId = "sess-not-empty",
            payload = PairRequestPayload(model = "KScan Glasses", appVersion = "1.0.0"),
        )
        assertRejected(f.validate(message), BridgeRejectCode.INVALID_MESSAGE)
    }

    @Test
    fun `stale timestamp is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val stale = f.sessionError().let {
            it.copy(timestamp = f.now - PhoneBridgeProtocol.TIMESTAMP_TOLERANCE_MS - 1)
        }
        assertRejected(f.validate(stale), BridgeRejectCode.STALE_MESSAGE)
    }

    @Test
    fun `future timestamp beyond tolerance is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val future = f.sessionError().let {
            it.copy(timestamp = f.now + PhoneBridgeProtocol.TIMESTAMP_TOLERANCE_MS + 1)
        }
        assertRejected(f.validate(future), BridgeRejectCode.STALE_MESSAGE)
    }

    @Test
    fun `expired message is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val expired = f.sessionError().let { it.copy(expiresAt = f.now - 1) }
        assertRejected(f.validate(expired), BridgeRejectCode.STALE_MESSAGE)
    }

    @Test
    fun `message from the wrong device is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val impostor = f.sessionError().let { it.copy(deviceId = "phone-2") }
        assertRejected(f.validate(impostor), BridgeRejectCode.WRONG_DEVICE)
    }

    @Test
    fun `oversized frame is rejected before parsing`() {
        val f = Fixture()
        val raw = "x".repeat(PhoneBridgeProtocol.MAX_MESSAGE_BYTES + 1)
        assertRejected(f.validateRaw(raw), BridgeRejectCode.PAYLOAD_TOO_LARGE)
    }

    @Test
    fun `malformed frame is rejected`() {
        val f = Fixture()
        assertRejected(f.validateRaw("not json {"), BridgeRejectCode.INVALID_MESSAGE)
        assertRejected(f.validateRaw("[1,2,3]"), BridgeRejectCode.INVALID_MESSAGE)
    }

    @Test
    fun `duplicate terminal completion is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        assertAccepted(f.validate(f.scanProcessing("scan-1")))
        assertAccepted(f.validate(f.scanCompleted("scan-1", requestId = "phone-req-1")))
        assertRejected(
            f.validate(f.scanCompleted("scan-1", requestId = "phone-req-2")),
            BridgeRejectCode.DUPLICATE_EVENT,
        )
    }

    @Test
    fun `scan completion before processing is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        assertRejected(
            f.validate(f.scanCompleted("scan-never-started", requestId = "phone-req-1")),
            BridgeRejectCode.INVALID_MESSAGE,
        )
    }

    @Test
    fun `action before session ready is rejected`() {
        val f = Fixture()
        f.pair() // paired, but session.ready has not arrived
        assertRejected(f.validate(f.actionSave()), BridgeRejectCode.SESSION_NOT_READY)
    }

    @Test
    fun `action after session revoke is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        assertAccepted(
            f.validate(
                PhoneBridgeMessage.SessionRevoked(
                    requestId = "phone-rev-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
                    payload = SessionRevokedPayload(reason = SessionRevokeReason.USER_REVOKED),
                ),
            ),
        )
        assertRejected(f.validate(f.actionSave()), BridgeRejectCode.SESSION_REVOKED)
    }

    @Test
    fun `unsupported message type is rejected`() {
        val f = Fixture()
        val raw = """
            {"messageType":"teleport.now","protocolVersion":1,"requestId":"r-1","sessionId":"s",
             "deviceId":"d","timestamp":$T0,"payload":{}}
        """.trimIndent()
        assertRejected(f.validateRaw(raw), BridgeRejectCode.UNSUPPORTED_MESSAGE_TYPE)
    }

    @Test
    fun `missing messageType is rejected`() {
        val f = Fixture()
        val raw = """
            {"protocolVersion":1,"requestId":"r-1","sessionId":"s",
             "deviceId":"d","timestamp":$T0,"payload":{}}
        """.trimIndent()
        assertRejected(f.validateRaw(raw), BridgeRejectCode.INVALID_MESSAGE)
    }

    @Test
    fun `reply with unknown correlation id is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val unsolicited = PhoneBridgeMessage.CaptureCompleted(
            requestId = "req-never-asked", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
            payload = CaptureCompletedPayload(captureId = "cap-9", captureRef = "ref-cap-9"),
        )
        assertRejected(f.validate(unsolicited), BridgeRejectCode.INVALID_MESSAGE)
    }

    @Test
    fun `message for an unknown session is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val wrong = f.sessionError().let { it.copy(sessionId = "sess-other") }
        assertRejected(f.validate(wrong), BridgeRejectCode.SESSION_NOT_READY)
    }

    @Test
    fun `message after session expiry is rejected`() {
        val f = Fixture()
        f.pair(ttlMs = 1_000L)
        f.ready()
        f.now += 2_000L
        val late = PhoneBridgeMessage.ConnectionPing(
            requestId = "glasses-ping-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = f.now,
            payload = ConnectionPingPayload(nonce = "n-1"),
        )
        assertRejected(f.validate(late), BridgeRejectCode.SESSION_EXPIRED)
    }

    // ----- payload safety -----

    @Test
    fun `token-bearing thumbnail url is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val result = sampleResult().copy(
            products = listOf(
                ResultProduct(
                    title = "Jacket", brand = "Brand", price = "10.00", currency = "USD",
                    group = RetailGroup.RETAIL,
                    thumbnailUrl = "https://cdn.example.com/a.jpg?token=abc123",
                ),
            ),
        )
        assertRejected(f.validate(f.resultShow(result = result)), BridgeRejectCode.INVALID_MESSAGE)
    }

    @Test
    fun `data uri thumbnail is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val result = sampleResult().copy(
            products = listOf(
                ResultProduct(
                    title = "Jacket", brand = "Brand", price = "10.00", currency = "USD",
                    group = RetailGroup.RETAIL,
                    thumbnailUrl = "data:image/png;base64,AAAA",
                ),
            ),
        )
        assertRejected(f.validate(f.resultShow(result = result)), BridgeRejectCode.INVALID_MESSAGE)
    }

    @Test
    fun `non-https thumbnail is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val result = sampleResult().copy(
            products = listOf(
                ResultProduct(
                    title = "Jacket", brand = "Brand", price = "10.00", currency = "USD",
                    group = RetailGroup.RETAIL,
                    thumbnailUrl = "http://cdn.example.com/a.jpg",
                ),
            ),
        )
        assertRejected(f.validate(f.resultShow(result = result)), BridgeRejectCode.INVALID_MESSAGE)
    }

    @Test
    fun `confidence outside zero to one is rejected`() {
        val f = Fixture()
        f.pairAndReady()
        val result = sampleResult().copy(confidence = 1.5f)
        assertRejected(f.validate(f.resultShow(result = result)), BridgeRejectCode.INVALID_MESSAGE)
    }
}
