package com.kscan.glasses.phonebridge.mock

import com.kscan.glasses.phonebridge.ActionOpenOnPhonePayload
import com.kscan.glasses.phonebridge.ActionRetryPayload
import com.kscan.glasses.phonebridge.ActionCancelPayload
import com.kscan.glasses.phonebridge.ActionSavePayload
import com.kscan.glasses.phonebridge.BridgeRejectCode
import com.kscan.glasses.phonebridge.CapturePreference
import com.kscan.glasses.phonebridge.CaptureRequestPayload
import com.kscan.glasses.phonebridge.InMemoryTransportPair
import com.kscan.glasses.phonebridge.PairRequestPayload
import com.kscan.glasses.phonebridge.PhoneBridgeCodec
import com.kscan.glasses.phonebridge.PhoneBridgeMessage
import com.kscan.glasses.phonebridge.PhoneBridgeProtocol
import com.kscan.glasses.phonebridge.PhoneBridgeValidator
import com.kscan.glasses.phonebridge.PhoneBridgeValidator.ValidationResult
import com.kscan.glasses.phonebridge.ResultPayload
import com.kscan.glasses.phonebridge.ResultProduct
import com.kscan.glasses.phonebridge.ResultShowPayload
import com.kscan.glasses.phonebridge.RetailGroup
import com.kscan.glasses.phonebridge.ScanStage
import com.kscan.glasses.phonebridge.ScanStatus
import com.kscan.glasses.phonebridge.SessionErrorPayload
import com.kscan.glasses.scan.ScanErrorCode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Deterministic mock-companion scenarios: happy path, pairing refusal,
 * pairing timeout, link loss and restore, scan failure, hostile frames
 * (oversized, duplicate, stale, wrong device), and session revocation.
 * Every phone frame is validated exactly once, in arrival order, exactly as
 * the glasses runtime would.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MockPhoneCompanionTest {

    private companion object {
        const val GLASSES_ID = "glasses-1"
        const val SESSION_TTL_MS = 60_000L
        const val T0 = 1_700_000_000_000L
    }

    /** Wired world: validator (glasses side) + mock (phone side). */
    private class World {
        var now = T0
        val transports = InMemoryTransportPair()
        val validator = PhoneBridgeValidator(GLASSES_ID) { now }
        val mock = MockPhoneCompanion(
            transport = transports.phoneSide,
            clock = { now },
            sessionTtlMs = SESSION_TTL_MS,
        )

        /** Raw phone→glasses frames in arrival order (for size assertions). */
        val phoneFrames = mutableListOf<String>()

        /** One validation result per phone frame, computed on arrival. */
        val results = mutableListOf<ValidationResult>()

        fun onPhoneFrame(raw: String) {
            phoneFrames.add(raw)
            results.add(validator.validateIncoming(raw))
        }

        /** Builds + registers a glasses pair.request and hands it to the mock. */
        suspend fun glassesPairRequest(requestId: String = "glasses-req-1") {
            val frame = validator.validateOutgoing(
                PhoneBridgeMessage.PairRequest(
                    requestId = requestId, deviceId = GLASSES_ID, timestamp = now,
                    payload = PairRequestPayload(model = "KScan Glasses", appVersion = "1.0.0"),
                ),
            )
            mock.handleIncoming(frame)
        }

        suspend fun glassesCaptureRequest(requestId: String = "glasses-cap-1") {
            val frame = validator.validateOutgoing(
                PhoneBridgeMessage.CaptureRequest(
                    requestId = requestId, sessionId = validator.currentSessionId!!,
                    deviceId = GLASSES_ID, timestamp = now,
                    payload = CaptureRequestPayload(preference = CapturePreference.AUTO),
                ),
            )
            mock.handleIncoming(frame)
        }

        suspend fun glassesActionSave(requestId: String = "glasses-act-1", resultId: String = "res-1") {
            val frame = validator.validateOutgoing(
                PhoneBridgeMessage.ActionSave(
                    requestId = requestId, sessionId = validator.currentSessionId!!,
                    deviceId = GLASSES_ID, timestamp = now,
                    payload = ActionSavePayload(resultId = resultId),
                ),
            )
            mock.handleIncoming(frame)
        }

        suspend fun glassesActionOpenOnPhone(requestId: String = "glasses-act-1", resultId: String = "res-1") {
            val frame = validator.validateOutgoing(
                PhoneBridgeMessage.ActionOpenOnPhone(
                    requestId = requestId, sessionId = validator.currentSessionId!!,
                    deviceId = GLASSES_ID, timestamp = now,
                    payload = ActionOpenOnPhonePayload(resultId = resultId),
                ),
            )
            mock.handleIncoming(frame)
        }

        suspend fun glassesActionRetry(requestId: String = "glasses-act-1", scanId: String = "scan-1") {
            val frame = validator.validateOutgoing(
                PhoneBridgeMessage.ActionRetry(
                    requestId = requestId, sessionId = validator.currentSessionId!!,
                    deviceId = GLASSES_ID, timestamp = now,
                    payload = ActionRetryPayload(scanId = scanId),
                ),
            )
            mock.handleIncoming(frame)
        }

        suspend fun glassesActionCancel(requestId: String = "glasses-act-1", scanId: String = "scan-1") {
            val frame = validator.validateOutgoing(
                PhoneBridgeMessage.ActionCancel(
                    requestId = requestId, sessionId = validator.currentSessionId!!,
                    deviceId = GLASSES_ID, timestamp = now,
                    payload = ActionCancelPayload(scanId = scanId),
                ),
            )
            mock.handleIncoming(frame)
        }

        suspend fun pairAndReady() {
            glassesPairRequest()
            mock.sendSessionReady()
        }
    }

    private fun acceptedMessages(world: World): List<PhoneBridgeMessage> =
        world.results.filterIsInstance<ValidationResult.Accepted>().map { it.message }

    private fun rejections(world: World): List<BridgeRejectCode> =
        world.results.filterIsInstance<ValidationResult.Rejected>().map { it.code }

    private fun runScenario(block: suspend World.() -> Unit) = runTest(UnconfinedTestDispatcher()) {
        val world = World()
        val collector = launch {
            world.transports.glassesSide.incoming.collect { world.onPhoneFrame(it) }
        }
        world.block()
        collector.cancel()
    }

    // ----- scenario 1: happy path -----

    @Test
    fun `happy path pairs, captures, scans, shows, and acks save`() = runScenario {
        pairAndReady()
        glassesCaptureRequest()
        mock.sendScanSequence(scanId = "scan-1", resultId = "res-1")
        mock.sendResultShow("res-1")
        glassesActionSave()

        assertTrue(rejections(this).isEmpty())
        assertEquals(
            listOf(
                "pair.approved", "session.ready",
                "capture.started", "capture.completed",
                "scan.processing", "scan.progress", "scan.progress", "scan.progress", "scan.completed",
                "result.show",
                "result.update",
            ),
            acceptedMessages(this).map { it.messageType },
        )
        // Deterministic ids: first session is sess-1, save ack bumps revision to 1.
        assertEquals("sess-1", validator.currentSessionId)
        val update = acceptedMessages(this).last() as PhoneBridgeMessage.ResultUpdate
        assertEquals(1, update.payload.revision)
        assertTrue(validator.sessionReady)
    }

    // ----- scenario 2: pairing denied -----

    @Test
    fun `pairing denied yields pair denied and no session`() = runScenario {
        mock.pairBehavior = MockPhoneCompanion.PairBehavior.DENY
        glassesPairRequest()

        assertEquals(listOf("pair.denied"), acceptedMessages(this).map { it.messageType })
        assertEquals(null, validator.currentSessionId)
    }

    // ----- scenario 3: pairing expires without a response -----

    @Test
    fun `pairing held until expiry yields silence then pair expired`() = runScenario {
        mock.pairBehavior = MockPhoneCompanion.PairBehavior.HOLD_UNTIL_EXPIRY
        glassesPairRequest()
        assertTrue("no response before expiry", phoneFrames.isEmpty())

        now += 10_000L
        mock.expireHeldPairRequest()

        assertEquals(listOf("pair.expired"), acceptedMessages(this).map { it.messageType })
        assertEquals(null, validator.currentSessionId)
    }

    // ----- scenario 4: connection lost mid-scan -----

    @Test
    fun `connection lost during scan stops further frames`() = runScenario {
        pairAndReady()
        glassesCaptureRequest()
        mock.sendScanProcessing("scan-1")
        mock.sendConnectionLost()
        mock.responsive = false
        // All of these are dropped by the dead link.
        mock.sendScanProgress("scan-1", ScanStage.ANALYZING, 60)
        mock.sendScanCompleted("scan-1", "res-1")

        assertEquals(
            listOf(
                "pair.approved", "session.ready",
                "capture.started", "capture.completed",
                "scan.processing", "connection.lost",
            ),
            acceptedMessages(this).map { it.messageType },
        )
    }

    // ----- scenario 5: connection restored -----

    @Test
    fun `connection restored resumes the exchange`() = runScenario {
        pairAndReady()
        mock.sendConnectionLost()
        mock.responsive = false
        mock.sendScanProcessing("scan-1") // dropped
        mock.responsive = true
        mock.sendConnectionRestored()
        mock.sendScanSequence(scanId = "scan-2", resultId = "res-2")

        assertTrue(rejections(this).isEmpty())
        assertEquals(
            listOf(
                "pair.approved", "session.ready",
                "connection.lost", "connection.restored",
                "scan.processing", "scan.progress", "scan.progress", "scan.progress", "scan.completed",
            ),
            acceptedMessages(this).map { it.messageType },
        )
    }

    // ----- scenario 6: scan failure with a safe error code -----

    @Test
    fun `scan failure surfaces a safe error code`() = runScenario {
        pairAndReady()
        mock.sendScanProcessing("scan-1")
        mock.sendScanFailed("scan-1", ScanErrorCode.BACKEND_UNAVAILABLE)

        val failed = acceptedMessages(this).last() as PhoneBridgeMessage.ScanFailed
        assertEquals(ScanErrorCode.BACKEND_UNAVAILABLE, failed.payload.code)
        assertTrue(rejections(this).isEmpty())
    }

    // ----- scenario 7: oversized result frame -----

    @Test
    fun `oversized result frame is rejected before parsing`() = runScenario {
        pairAndReady()
        mock.sendOversizedResultShow()

        val oversized = phoneFrames.last()
        assertTrue(oversized.toByteArray(Charsets.UTF_8).size > PhoneBridgeProtocol.MAX_MESSAGE_BYTES)
        assertEquals(listOf(BridgeRejectCode.PAYLOAD_TOO_LARGE), rejections(this))
    }

    // ----- scenario 8: duplicate scan completion -----

    @Test
    fun `duplicate scan completion is rejected`() = runScenario {
        pairAndReady()
        mock.sendDuplicateScanCompleted("scan-1", "res-1")

        assertEquals(listOf(BridgeRejectCode.DUPLICATE_EVENT), rejections(this))
        assertEquals(
            listOf("pair.approved", "session.ready", "scan.processing", "scan.completed"),
            acceptedMessages(this).map { it.messageType },
        )
    }

    // ----- scenario 9: stale timestamp -----

    @Test
    fun `stale frame is rejected`() = runScenario {
        pairAndReady()
        mock.sendStaleSessionError()

        assertEquals(listOf(BridgeRejectCode.STALE_MESSAGE), rejections(this))
    }

    // ----- scenario 10: wrong device -----

    @Test
    fun `frame from an unpaired device is rejected`() = runScenario {
        pairAndReady()
        mock.sendWrongDeviceSessionError()

        assertEquals(listOf(BridgeRejectCode.WRONG_DEVICE), rejections(this))
    }

    // ----- scenario 11: revoked session rejects further actions -----

    @Test
    fun `revoked session rejects the post-revoke exchange`() = runScenario {
        pairAndReady()
        mock.revokeSession()
        // Glasses still sends the action; the mock answers with a session error.
        glassesActionSave()

        assertEquals(
            listOf("pair.approved", "session.ready", "session.revoked"),
            acceptedMessages(this).map { it.messageType },
        )
        // The mock's post-revoke session.error is rejected SESSION_REVOKED.
        assertEquals(listOf(BridgeRejectCode.SESSION_REVOKED), rejections(this))
        assertTrue(validator.sessionRevoked)
    }

    // ----- security / privacy extras -----

    @Test
    fun `result with token-bearing thumbnail url is rejected`() = runScenario {
        pairAndReady()
        val hostile = PhoneBridgeMessage.ResultShow(
            requestId = "phone-req-x",
            sessionId = validator.currentSessionId!!,
            deviceId = mock.deviceId,
            timestamp = now,
            payload = ResultShowPayload(
                result = ResultPayload(
                    resultId = "res-x",
                    summary = "Jacket",
                    confidence = 0.9f,
                    products = listOf(
                        ResultProduct(
                            title = "Jacket", brand = "Brand", price = "10.00", currency = "USD",
                            group = RetailGroup.RETAIL,
                            thumbnailUrl = "https://cdn.example.com/a.jpg?access_token=secret",
                        ),
                    ),
                    availableActions = emptyList(),
                    scanStatus = ScanStatus.COMPLETED,
                ),
            ),
        )
        transports.phoneSide.send(PhoneBridgeCodec.encode(hostile))

        assertEquals(listOf(BridgeRejectCode.INVALID_MESSAGE), rejections(this))
    }

    @Test
    fun `frame for an invalid session is rejected`() = runScenario {
        pairAndReady()
        val wrong = PhoneBridgeMessage.SessionError(
            requestId = "phone-req-x",
            sessionId = "sess-not-current",
            deviceId = mock.deviceId,
            timestamp = now,
            payload = SessionErrorPayload(code = "UNKNOWN_SAFE_ERROR", recoverable = true),
        )
        transports.phoneSide.send(PhoneBridgeCodec.encode(wrong))

        assertEquals(listOf(BridgeRejectCode.SESSION_NOT_READY), rejections(this))
    }

    @Test
    fun `mock stays silent on actions before any pairing`() = runScenario {
        // No pairing at all: the mock has no session to ack against.
        val frame = PhoneBridgeCodec.encode(
            PhoneBridgeMessage.ActionSave(
                requestId = "glasses-act-1", sessionId = "sess-ghost",
                deviceId = GLASSES_ID, timestamp = now,
                payload = ActionSavePayload(resultId = "res-1"),
            ),
        )
        mock.handleIncoming(frame)

        assertTrue(phoneFrames.isEmpty())
    }

    @Test
    fun `pair approved is correlated to the outstanding pair request`() = runScenario {
        pairAndReady()
        val approved = acceptedMessages(this).first() as PhoneBridgeMessage.PairApproved
        assertEquals("glasses-req-1", approved.requestId)
        assertEquals(mock.deviceId, approved.deviceId)
        assertEquals(now + SESSION_TTL_MS, approved.payload.sessionExpiresAt)
    }

    // ----- action acknowledgements -----

    @Test
    fun `open on phone action is acked with a result update`() = runScenario {
        pairAndReady()
        mock.sendResultShow("res-1")
        glassesActionOpenOnPhone()

        val update = acceptedMessages(this).last() as PhoneBridgeMessage.ResultUpdate
        assertEquals("res-1", update.payload.result.resultId)
        assertEquals(1, update.payload.revision)
        assertTrue(rejections(this).isEmpty())
    }

    @Test
    fun `retry action is acked with scan processing for a fresh scan`() = runScenario {
        pairAndReady()
        glassesActionRetry(scanId = "scan-1")

        val processing = acceptedMessages(this).last() as PhoneBridgeMessage.ScanProcessing
        assertTrue(processing.payload.scanId.startsWith("scan-"))
        assertTrue(rejections(this).isEmpty())
    }

    @Test
    fun `cancel action is acked with a cancelled scan failure`() = runScenario {
        pairAndReady()
        mock.sendScanProcessing("scan-1")
        glassesActionCancel(scanId = "scan-1")

        val failed = acceptedMessages(this).last() as PhoneBridgeMessage.ScanFailed
        assertEquals("scan-1", failed.payload.scanId)
        assertEquals(ScanErrorCode.CANCELLED, failed.payload.code)
        assertTrue(rejections(this).isEmpty())
    }

    @Test
    fun `rejected actions yield a recoverable session error`() = runScenario {
        pairAndReady()
        mock.rejectActions = true
        glassesActionSave()
        glassesActionOpenOnPhone(requestId = "glasses-act-2")
        glassesActionRetry(requestId = "glasses-act-3")
        glassesActionCancel(requestId = "glasses-act-4")

        val errors = acceptedMessages(this).filterIsInstance<PhoneBridgeMessage.SessionError>()
        assertEquals(4, errors.size)
        assertTrue(errors.all { it.payload.code == MockPhoneCompanion.REJECTED_ACTION_CODE })
        assertTrue(errors.all { it.payload.recoverable })
        // Rejections are answers, not acks: no result.update, no scan frames.
        assertTrue(acceptedMessages(this).none { it is PhoneBridgeMessage.ResultUpdate })
        assertTrue(acceptedMessages(this).none { it is PhoneBridgeMessage.ScanProcessing })
        assertTrue(rejections(this).isEmpty())
    }
}
