package com.kscan.glasses.runtime

import com.kscan.glasses.phonebridge.ConnectionLostReason
import com.kscan.glasses.phonebridge.PairDenyReason
import com.kscan.glasses.phonebridge.PhoneBridgeEvent
import com.kscan.glasses.phonebridge.ResultAction
import com.kscan.glasses.phonebridge.ResultPayload
import com.kscan.glasses.phonebridge.ScanStage
import com.kscan.glasses.phonebridge.ScanStatus
import com.kscan.glasses.phonebridge.SessionRevokeReason
import com.kscan.glasses.scan.ScanErrorCode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Transition coverage for [ConnectedRuntimeStateMachine]: every legal
 * transition, representative illegal ones, and the duplicate/stale guards.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ConnectedRuntimeStateMachineTest {

    private class Fixture {
        val sm = ConnectedRuntimeStateMachine()
        val effects = mutableListOf<ConnectedEffect>()

        val state: ConnectedState get() = sm.uiState.value.state

        fun bridge(event: PhoneBridgeEvent) = sm.on(ConnectedInput.Bridge(event))

        fun driveToReady() {
            sm.on(ConnectedInput.PairTapped)
            bridge(PhoneBridgeEvent.PairApproved(sessionId = "sess-1", sessionExpiresAt = Long.MAX_VALUE))
            bridge(PhoneBridgeEvent.SessionReady(phoneAppVersion = "1.0.0", features = emptyList()))
        }

        fun driveToResults(scanId: String = "scan-1", resultId: String = "res-1") {
            driveToReady()
            sm.on(ConnectedInput.ScanTapped)
            bridge(PhoneBridgeEvent.CaptureStarted(captureId = "cap-1"))
            bridge(PhoneBridgeEvent.CaptureCompleted(captureId = "cap-1", captureRef = "ref-cap-1"))
            bridge(PhoneBridgeEvent.ScanProcessing(scanId = scanId))
            bridge(PhoneBridgeEvent.ScanProgress(scanId = scanId, stage = ScanStage.ANALYZING, percent = 60))
            bridge(PhoneBridgeEvent.ScanCompleted(scanId = scanId, resultId = resultId))
        }

        fun result(resultId: String) = ResultPayload(
            resultId = resultId,
            summary = "Vintage black leather jacket",
            confidence = 0.9f,
            products = emptyList(),
            availableActions = listOf(ResultAction.SAVE),
            scanStatus = ScanStatus.COMPLETED,
        )
    }

    private fun runFixture(block: Fixture.() -> Unit) = runTest(UnconfinedTestDispatcher()) {
        val f = Fixture()
        val collector = launch { f.sm.effects.collect { f.effects.add(it) } }
        f.block()
        collector.cancel()
    }

    // ----- legal transitions: pairing path -----

    @Test
    fun `disconnected to pairing on pair intent with effect`() = runFixture {
        sm.on(ConnectedInput.PairTapped)

        assertEquals(ConnectedState.PAIRING, state)
        assertEquals(listOf(ConnectedEffect.RequestPairing), effects)
    }

    @Test
    fun `pairing to connected on pair approved`() = runFixture {
        sm.on(ConnectedInput.PairTapped)
        bridge(PhoneBridgeEvent.PairApproved("sess-1", Long.MAX_VALUE))

        assertEquals(ConnectedState.CONNECTED, state)
    }

    @Test
    fun `pairing to error on denied and on expired`() = runFixture {
        sm.on(ConnectedInput.PairTapped)
        bridge(PhoneBridgeEvent.PairDenied(PairDenyReason.USER_REJECTED))
        assertEquals(ConnectedState.ERROR, state)
        assertEquals(ConnectedRuntimeStateMachine.ERROR_PAIRING_DENIED, sm.uiState.value.errorCode)
        assertEquals(RecoveryBehavior.RETRY_PAIRING, sm.uiState.value.metadata.recovery)

        val sm2 = ConnectedRuntimeStateMachine()
        sm2.on(ConnectedInput.PairTapped)
        sm2.on(ConnectedInput.Bridge(PhoneBridgeEvent.PairExpired))
        assertEquals(ConnectedState.ERROR, sm2.uiState.value.state)
        assertEquals(ConnectedRuntimeStateMachine.ERROR_PAIRING_EXPIRED, sm2.uiState.value.errorCode)
    }

    @Test
    fun `connected to ready on session ready`() = runFixture {
        sm.on(ConnectedInput.PairTapped)
        bridge(PhoneBridgeEvent.PairApproved("sess-1", Long.MAX_VALUE))
        bridge(PhoneBridgeEvent.SessionReady("1.0.0", emptyList()))

        assertEquals(ConnectedState.READY, state)
    }

    // ----- legal transitions: scan path -----

    @Test
    fun `ready to capture requested with effect`() = runFixture {
        driveToReady()
        effects.clear()

        sm.on(ConnectedInput.ScanTapped)

        assertEquals(ConnectedState.CAPTURE_REQUESTED, state)
        assertEquals(listOf(ConnectedEffect.RequestCapture), effects)
    }

    @Test
    fun `capture requested to capturing on phone`() = runFixture {
        driveToReady()
        sm.on(ConnectedInput.ScanTapped)
        bridge(PhoneBridgeEvent.CaptureStarted("cap-1"))

        assertEquals(ConnectedState.CAPTURING_ON_PHONE, state)
    }

    @Test
    fun `capturing on phone to privacy processing`() = runFixture {
        driveToReady()
        sm.on(ConnectedInput.ScanTapped)
        bridge(PhoneBridgeEvent.CaptureStarted("cap-1"))
        bridge(PhoneBridgeEvent.CaptureCompleted("cap-1", "ref-cap-1"))

        assertEquals(ConnectedState.PRIVACY_PROCESSING, state)
    }

    @Test
    fun `privacy processing to analyzing with bounded progress`() = runFixture {
        driveToReady()
        sm.on(ConnectedInput.ScanTapped)
        bridge(PhoneBridgeEvent.CaptureStarted("cap-1"))
        bridge(PhoneBridgeEvent.CaptureCompleted("cap-1", "ref-cap-1"))
        bridge(PhoneBridgeEvent.ScanProcessing("scan-1"))
        bridge(PhoneBridgeEvent.ScanProgress("scan-1", ScanStage.PRIVACY_PROCESSING, 25))
        assertEquals(ConnectedState.PRIVACY_PROCESSING, state)
        assertEquals(25, sm.uiState.value.progressPercent)

        bridge(PhoneBridgeEvent.ScanProgress("scan-1", ScanStage.ANALYZING, 60))

        assertEquals(ConnectedState.ANALYZING, state)
        assertEquals(60, sm.uiState.value.progressPercent)
        assertEquals(ProgressKind.BOUNDED, sm.uiState.value.metadata.progress.kind)
        assertEquals(60, sm.uiState.value.metadata.progress.percent)
    }

    @Test
    fun `analyzing to results on matching scan completion`() = runFixture {
        driveToResults()

        assertEquals(ConnectedState.RESULTS, state)
        assertEquals("res-1", sm.uiState.value.resultId)
    }

    @Test
    fun `results to action confirmed on save ack`() = runFixture {
        driveToResults()
        sm.on(ConnectedInput.SaveTapped)
        assertEquals(listOf(ConnectedEffect.SaveResult("res-1")), effects.last().let(::listOf))
        assertEquals(ConnectedState.RESULTS, state) // still waiting for the ack

        bridge(PhoneBridgeEvent.ResultUpdated(result("res-1"), revision = 1))

        assertEquals(ConnectedState.ACTION_CONFIRMED, state)
    }

    @Test
    fun `action confirmed to ready on done`() = runFixture {
        driveToResults()
        bridge(PhoneBridgeEvent.ResultUpdated(result("res-1"), revision = 1))
        sm.on(ConnectedInput.DoneTapped)

        assertEquals(ConnectedState.READY, state)
        assertNull(sm.uiState.value.resultId)
    }

    // ----- reconnection -----

    @Test
    fun `connection lost from any active state moves to reconnecting`() = runFixture {
        // From READY.
        driveToReady()
        bridge(PhoneBridgeEvent.ConnectionLost(ConnectionLostReason.TRANSPORT_LOST))
        assertEquals(ConnectedState.RECONNECTING, state)

        // From ANALYZING (mid-scan), on a fresh machine.
        val f2 = Fixture()
        f2.driveToResults("scan-2", "res-2")
        f2.sm.on(ConnectedInput.RetryTapped)
        f2.bridge(PhoneBridgeEvent.ScanProcessing("scan-3"))
        f2.bridge(PhoneBridgeEvent.ScanProgress("scan-3", ScanStage.ANALYZING, 40))
        assertEquals(ConnectedState.ANALYZING, f2.state)
        f2.bridge(PhoneBridgeEvent.ConnectionLost(ConnectionLostReason.TIMEOUT))
        assertEquals(ConnectedState.RECONNECTING, f2.state)
    }

    @Test
    fun `reconnecting restores the prior safe state`() = runFixture {
        driveToResults("scan-1", "res-1")
        bridge(PhoneBridgeEvent.ConnectionLost(ConnectionLostReason.TRANSPORT_LOST))
        assertEquals(ConnectedState.RECONNECTING, state)

        bridge(PhoneBridgeEvent.ConnectionRestored)

        assertEquals(ConnectedState.RESULTS, state)
        assertEquals("res-1", sm.uiState.value.resultId)
    }

    @Test
    fun `reconnecting to error on timeout`() = runFixture {
        driveToReady()
        bridge(PhoneBridgeEvent.ConnectionLost(ConnectionLostReason.TRANSPORT_LOST))
        sm.on(ConnectedInput.OperationTimeout)

        assertEquals(ConnectedState.ERROR, state)
        assertEquals(ConnectedRuntimeStateMachine.TIMEOUT_RECONNECT, sm.uiState.value.errorCode)
    }

    // ----- revocation -----

    @Test
    fun `session revoked from any session state lands disconnected`() = runFixture {
        // From READY.
        driveToReady()
        bridge(PhoneBridgeEvent.SessionRevoked(SessionRevokeReason.USER_REVOKED))
        assertEquals(ConnectedState.DISCONNECTED, state)

        // From mid-scan.
        driveToResults("scan-2", "res-2")
        sm.on(ConnectedInput.RetryTapped)
        bridge(PhoneBridgeEvent.ScanProcessing("scan-3"))
        bridge(PhoneBridgeEvent.SessionRevoked(SessionRevokeReason.REPLACED))
        assertEquals(ConnectedState.DISCONNECTED, state)
        assertNull(sm.uiState.value.scanId)

        // From RECONNECTING.
        driveToReady()
        bridge(PhoneBridgeEvent.ConnectionLost(ConnectionLostReason.TRANSPORT_LOST))
        bridge(PhoneBridgeEvent.SessionRevoked(SessionRevokeReason.ERROR))
        assertEquals(ConnectedState.DISCONNECTED, state)
    }

    // ----- duplicates and staleness -----

    @Test
    fun `duplicate scan completion produces no duplicate visible result`() = runFixture {
        driveToResults("scan-1", "res-1")
        assertEquals(ConnectedState.RESULTS, state)
        effects.clear()

        // Replay: same completion, and a result.show for the same result.
        bridge(PhoneBridgeEvent.ScanCompleted("scan-1", "res-1"))
        bridge(PhoneBridgeEvent.ResultShown(result("res-1")))

        assertEquals(ConnectedState.RESULTS, state)
        assertEquals("res-1", sm.uiState.value.resultId)
        // No Save/Open/etc. effect was emitted as a side effect of the replay.
        assertTrue(effects.isEmpty())
    }

    @Test
    fun `stale completion cannot overwrite a newer scan`() = runFixture {
        driveToResults("scan-1", "res-1")

        // User retries: a newer scan begins.
        sm.on(ConnectedInput.RetryTapped)
        bridge(PhoneBridgeEvent.ScanProcessing("scan-2"))
        bridge(PhoneBridgeEvent.ScanProgress("scan-2", ScanStage.ANALYZING, 50))
        assertEquals(ConnectedState.ANALYZING, state)
        assertEquals("scan-2", sm.uiState.value.scanId)

        // Late completion for the OLD scan must be ignored.
        bridge(PhoneBridgeEvent.ScanCompleted("scan-1", "res-1"))
        assertEquals(ConnectedState.ANALYZING, state)

        // The newer scan completes normally.
        bridge(PhoneBridgeEvent.ScanCompleted("scan-2", "res-2"))
        assertEquals(ConnectedState.RESULTS, state)
        assertEquals("res-2", sm.uiState.value.resultId)
    }

    // ----- cancellation -----

    @Test
    fun `cancel during an active scan emits cancel and returns ready`() = runFixture {
        driveToReady()
        sm.on(ConnectedInput.ScanTapped)
        bridge(PhoneBridgeEvent.CaptureStarted("cap-1"))
        bridge(PhoneBridgeEvent.CaptureCompleted("cap-1", "ref-cap-1"))
        bridge(PhoneBridgeEvent.ScanProcessing("scan-1"))
        effects.clear()

        sm.on(ConnectedInput.CancelTapped)

        assertEquals(ConnectedState.READY, state)
        assertEquals(listOf(ConnectedEffect.CancelScan("scan-1")), effects)
        assertNull(sm.uiState.value.scanId)
    }

    @Test
    fun `cancel during pairing lands disconnected without effects`() = runFixture {
        sm.on(ConnectedInput.PairTapped)
        effects.clear()

        sm.on(ConnectedInput.CancelTapped)

        assertEquals(ConnectedState.DISCONNECTED, state)
        assertTrue(effects.isEmpty())
    }

    // ----- failure events -----

    @Test
    fun `capture failure yields a recoverable error`() = runFixture {
        driveToReady()
        sm.on(ConnectedInput.ScanTapped)
        bridge(PhoneBridgeEvent.CaptureFailed("cap-1", ScanErrorCode.CAPTURE_UNAVAILABLE))

        assertEquals(ConnectedState.ERROR, state)
        assertEquals(ScanErrorCode.CAPTURE_UNAVAILABLE.name, sm.uiState.value.errorCode)
        assertEquals(RecoveryBehavior.RETURN_READY, sm.uiState.value.metadata.recovery)

        // Retry returns to READY.
        sm.on(ConnectedInput.RetryTapped)
        assertEquals(ConnectedState.READY, state)
    }

    @Test
    fun `scan failure yields a recoverable error carrying the safe code`() = runFixture {
        driveToReady()
        sm.on(ConnectedInput.ScanTapped)
        bridge(PhoneBridgeEvent.ScanProcessing("scan-1"))
        bridge(PhoneBridgeEvent.ScanFailed("scan-1", ScanErrorCode.BACKEND_UNAVAILABLE))

        assertEquals(ConnectedState.ERROR, state)
        assertEquals(ScanErrorCode.BACKEND_UNAVAILABLE.name, sm.uiState.value.errorCode)
    }

    @Test
    fun `session error recovery follows the recoverable flag`() = runFixture {
        driveToReady()
        bridge(PhoneBridgeEvent.SessionError(code = "BACKEND_UNAVAILABLE", recoverable = true))
        assertEquals(ConnectedState.ERROR, state)
        sm.on(ConnectedInput.RetryTapped)
        assertEquals(ConnectedState.READY, state)

        bridge(PhoneBridgeEvent.SessionError(code = "AUTH_LOST", recoverable = false))
        assertEquals(ConnectedState.ERROR, state)
        sm.on(ConnectedInput.RetryTapped)
        assertEquals(ConnectedState.DISCONNECTED, state)
    }

    // ----- illegal transitions: ignored -----

    @Test
    fun `illegal transitions are ignored`() = runFixture {
        // Session events before pairing.
        bridge(PhoneBridgeEvent.SessionReady("1.0.0", emptyList()))
        bridge(PhoneBridgeEvent.PairApproved("sess-1", Long.MAX_VALUE))
        assertEquals(ConnectedState.DISCONNECTED, state)

        // Scan intent while disconnected.
        sm.on(ConnectedInput.ScanTapped)
        assertEquals(ConnectedState.DISCONNECTED, state)
        assertTrue(effects.isEmpty())

        // Session.ready must not skip CONNECTED.
        sm.on(ConnectedInput.PairTapped)
        bridge(PhoneBridgeEvent.SessionReady("1.0.0", emptyList()))
        assertEquals(ConnectedState.PAIRING, state)

        // Capture events while only CONNECTED.
        bridge(PhoneBridgeEvent.PairApproved("sess-1", Long.MAX_VALUE))
        bridge(PhoneBridgeEvent.CaptureStarted("cap-1"))
        assertEquals(ConnectedState.CONNECTED, state)

        // Scan intent while already in RESULTS.
        driveToResults("scan-1", "res-1")
        sm.on(ConnectedInput.ScanTapped)
        assertEquals(ConnectedState.RESULTS, state)

        // Save ack while merely READY.
        val f2 = Fixture()
        f2.driveToReady()
        f2.bridge(PhoneBridgeEvent.ResultUpdated(f2.result("res-x"), revision = 1))
        assertEquals(ConnectedState.READY, f2.state)
    }

    @Test
    fun `retry from results emits retry and re-arms capture`() = runFixture {
        driveToResults("scan-1", "res-1")
        effects.clear()

        sm.on(ConnectedInput.RetryTapped)

        assertEquals(listOf(ConnectedEffect.RetryScan("scan-1")), effects)
        assertEquals(ConnectedState.CAPTURE_REQUESTED, state)
    }

    @Test
    fun `open on phone intent emits effect and stays on results`() = runFixture {
        driveToResults("scan-1", "res-1")
        effects.clear()

        sm.on(ConnectedInput.OpenOnPhoneTapped)

        assertEquals(listOf(ConnectedEffect.OpenOnPhone("res-1")), effects)
        assertEquals(ConnectedState.RESULTS, state)
    }

    @Test
    fun `result dismissed by phone returns ready`() = runFixture {
        driveToResults("scan-1", "res-1")

        bridge(PhoneBridgeEvent.ResultDismissed("res-1"))

        assertEquals(ConnectedState.READY, state)
        assertNull(sm.uiState.value.resultId)
    }

    // ----- metadata contract -----

    @Test
    fun `every state exposes a complete hud contract`() {
        for (state in ConnectedState.entries) {
            val metadata = ConnectedRuntimeStateMachine.metadataFor(state)
            assertTrue("$state title", metadata.title.isNotBlank())
            assertTrue("$state copy", metadata.supportingCopy.isNotBlank())
            assertTrue("$state primary label", metadata.primaryAction.label.isNotBlank())
            assertTrue("$state secondary cap", metadata.secondaryActions.size <= 3)
            val allActions = listOf(metadata.primaryAction.action) + metadata.secondaryActions.map { it.action }
            assertTrue("$state focus in actions", metadata.defaultFocus in allActions)
            if (metadata.progress.kind == ProgressKind.BOUNDED) {
                // Percent may be null statically, but kind must be bounded only for scan states.
                assertTrue(
                    "$state bounded only for scan states",
                    state == ConnectedState.PRIVACY_PROCESSING || state == ConnectedState.ANALYZING,
                )
            }
        }
        // Timeout declarations on the timed states only.
        val timed = setOf(
            ConnectedState.PAIRING, ConnectedState.CONNECTED, ConnectedState.CAPTURE_REQUESTED,
            ConnectedState.CAPTURING_ON_PHONE, ConnectedState.PRIVACY_PROCESSING,
            ConnectedState.ANALYZING, ConnectedState.RECONNECTING,
        )
        for (state in ConnectedState.entries) {
            val timeout = ConnectedRuntimeStateMachine.metadataFor(state).timeout
            if (state in timed) {
                val durationMs = timeout.durationMs
                assertTrue("$state must declare a timeout", durationMs != null && durationMs > 0)
            } else {
                assertNull("$state must not declare a timeout", timeout.durationMs)
            }
        }
    }

    @Test
    fun `states are mutually exclusive single source of truth`() = runFixture {
        driveToResults()
        // One state value; no parallel flags exist to contradict it.
        assertEquals(ConnectedState.RESULTS, sm.uiState.value.state)
        assertNotEquals(ConnectedState.READY, sm.uiState.value.state)
    }
}
