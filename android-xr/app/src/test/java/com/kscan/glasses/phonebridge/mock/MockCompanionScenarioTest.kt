package com.kscan.glasses.phonebridge.mock

import com.kscan.glasses.phonebridge.ActionCancelPayload
import com.kscan.glasses.phonebridge.ActionRetryPayload
import com.kscan.glasses.phonebridge.BridgeRejectCode
import com.kscan.glasses.phonebridge.CapturePreference
import com.kscan.glasses.phonebridge.CaptureRequestPayload
import com.kscan.glasses.phonebridge.InMemoryTransportPair
import com.kscan.glasses.phonebridge.PairRequestPayload
import com.kscan.glasses.phonebridge.PhoneBridgeMessage
import com.kscan.glasses.phonebridge.PhoneBridgeValidator
import com.kscan.glasses.phonebridge.PhoneBridgeValidator.ValidationResult
import com.kscan.glasses.scan.ScanErrorCode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Autopilot and scenario-seam coverage for the mock phone companion: the
 * self-driving happy path used on emulator, the one-shot fault flags, and the
 * [MockCompanionScenarios] name mapping. Everything is validated in arrival
 * order exactly as the glasses runtime would.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MockCompanionScenarioTest {

    private companion object {
        const val GLASSES_ID = "glasses-1"
        const val T0 = 1_700_000_000_000L
    }

    private class World {
        var now = T0
        val transports = InMemoryTransportPair()
        val validator = PhoneBridgeValidator(GLASSES_ID) { now }
        val mock = MockPhoneCompanion(
            transport = transports.phoneSide,
            clock = { now },
        )
        val results = mutableListOf<ValidationResult>()

        fun onPhoneFrame(raw: String) {
            results.add(validator.validateIncoming(raw))
        }

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

        suspend fun glassesActionCancel(requestId: String = "glasses-act-1", scanId: String) {
            val frame = validator.validateOutgoing(
                PhoneBridgeMessage.ActionCancel(
                    requestId = requestId, sessionId = validator.currentSessionId!!,
                    deviceId = GLASSES_ID, timestamp = now,
                    payload = ActionCancelPayload(scanId = scanId),
                ),
            )
            mock.handleIncoming(frame)
        }
    }

    private fun accepted(world: World): List<PhoneBridgeMessage> =
        world.results.filterIsInstance<ValidationResult.Accepted>().map { it.message }

    private fun types(world: World): List<String> = accepted(world).map { it.messageType }

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

    // ----- autopilot -----

    @Test
    fun `autopilot pairing emits session ready after approval`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()

        assertEquals(listOf("pair.approved", "session.ready"), types(this))
        assertTrue(rejections(this).isEmpty())
        assertTrue(validator.sessionReady)
    }

    @Test
    fun `autopilot capture drives the full scan burst through result show`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()
        glassesCaptureRequest()

        assertEquals(
            listOf(
                "pair.approved", "session.ready",
                "capture.started", "capture.completed",
                "scan.processing", "scan.progress", "scan.progress", "scan.progress",
                "scan.completed", "result.show",
            ),
            types(this),
        )
        assertTrue(rejections(this).isEmpty())
    }

    @Test
    fun `autopilot retry drives a fresh full scan burst`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()
        glassesCaptureRequest()
        glassesActionRetry()

        // Two full bursts: capture-triggered, then retry-triggered.
        assertEquals(2, accepted(this).filterIsInstance<PhoneBridgeMessage.ScanCompleted>().size)
        assertEquals(2, accepted(this).filterIsInstance<PhoneBridgeMessage.ResultShow>().size)
        assertTrue(rejections(this).isEmpty())
    }

    @Test
    fun `fail next scan fails after processing and is consumed`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()
        mock.failNextScan = true
        glassesCaptureRequest()

        val failed = accepted(this).filterIsInstance<PhoneBridgeMessage.ScanFailed>()
        assertEquals(1, failed.size)
        assertEquals(ScanErrorCode.BACKEND_UNAVAILABLE, failed.single().payload.code)
        assertTrue(accepted(this).none { it is PhoneBridgeMessage.ScanCompleted })
        assertFalse("one-shot flag consumed", mock.failNextScan)

        // The following scan succeeds normally.
        glassesCaptureRequest(requestId = "glasses-cap-2")
        assertEquals(1, accepted(this).filterIsInstance<PhoneBridgeMessage.ScanCompleted>().size)
    }

    @Test
    fun `hold next scan stalls after processing until cancelled`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()
        mock.holdNextScan = true
        glassesCaptureRequest()

        assertEquals(1, accepted(this).filterIsInstance<PhoneBridgeMessage.ScanProcessing>().size)
        assertTrue(accepted(this).none { it is PhoneBridgeMessage.ScanCompleted })
        assertFalse("one-shot flag consumed", mock.holdNextScan)

        val heldScanId = (accepted(this).last() as PhoneBridgeMessage.ScanProcessing).payload.scanId
        glassesActionCancel(scanId = heldScanId)

        val failed = accepted(this).filterIsInstance<PhoneBridgeMessage.ScanFailed>().single()
        assertEquals(heldScanId, failed.payload.scanId)
        assertEquals(ScanErrorCode.CANCELLED, failed.payload.code)
        assertTrue(rejections(this).isEmpty())
    }

    @Test
    fun `duplicate next completion is rejected and never duplicated downstream`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()
        mock.duplicateNextCompletion = true
        glassesCaptureRequest()

        assertEquals(1, accepted(this).filterIsInstance<PhoneBridgeMessage.ScanCompleted>().size)
        assertEquals(listOf(BridgeRejectCode.DUPLICATE_EVENT), rejections(this))
        assertFalse("one-shot flag consumed", mock.duplicateNextCompletion)
    }

    // ----- scenario mapping -----

    @Test
    fun `unknown scenario returns false and changes nothing`() = runScenario {
        assertFalse(MockCompanionScenarios.apply(mock, "not_a_scenario"))
        assertFalse(mock.autopilot)
        assertTrue(results.isEmpty())
    }

    @Test
    fun `pairing scenarios drive deny hold and expiry`() = runScenario {
        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.PAIR_DENY))
        glassesPairRequest()
        assertEquals(listOf("pair.denied"), types(this))

        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.PAIR_HOLD))
        glassesPairRequest(requestId = "glasses-req-2")
        assertEquals(listOf("pair.denied"), types(this)) // held: no reply yet

        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.PAIR_EXPIRE))
        assertEquals(listOf("pair.denied", "pair.expired"), types(this))
    }

    @Test
    fun `session revoke scenario emits session revoked`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()

        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.SESSION_REVOKE))

        assertEquals(listOf("pair.approved", "session.ready", "session.revoked"), types(this))
        assertTrue(validator.sessionRevoked)
    }

    @Test
    fun `connection scenarios emit lost and restored`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()

        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.CONNECTION_LOST))
        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.CONNECTION_RESTORED))

        assertEquals(
            listOf("pair.approved", "session.ready", "connection.lost", "connection.restored"),
            types(this),
        )
    }

    @Test
    fun `stale and wrong-device scenarios are rejected by the validator`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()

        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.STALE_ERROR))
        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.WRONG_DEVICE))

        assertEquals(
            listOf(BridgeRejectCode.STALE_MESSAGE, BridgeRejectCode.WRONG_DEVICE),
            rejections(this),
        )
    }

    @Test
    fun `responsive scenarios drop and resume the link`() = runScenario {
        mock.autopilot = true
        glassesPairRequest()

        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.RESPONSIVE_OFF))
        mock.sendConnectionLost() // dropped by the dead link
        assertEquals(listOf("pair.approved", "session.ready"), types(this))

        assertTrue(MockCompanionScenarios.apply(mock, MockCompanionScenarios.RESPONSIVE_ON))
        mock.sendConnectionLost()
        assertEquals(listOf("pair.approved", "session.ready", "connection.lost"), types(this))
    }
}
