package com.kscan.glasses.phonebridge

import com.kscan.glasses.phonebridge.mock.MockPhoneBridgeProvider
import com.kscan.glasses.phonebridge.mock.MockPhoneCompanion
import com.kscan.glasses.scan.ScanErrorCode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Provider-layer coverage: fail-safe disabled/unavailable states, end-to-end
 * mock exchange over the raw-frame transport, and structured-concurrency
 * guarantees (cancellation closes pending work; connection loss leaks nothing).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PhoneBridgeProviderTest {

    // ----- disabled provider -----

    @Test
    fun `disabled provider fails safely without throwing`() = runTest {
        val provider = DisabledPhoneBridgeProvider()

        assertEquals(PhoneBridgeProviderStatus.DISABLED, provider.status.value)
        assertEquals(PhoneBridgeSendResult.Disabled, provider.requestPairing())
        assertEquals(PhoneBridgeSendResult.Disabled, provider.requestCapture())
        assertEquals(PhoneBridgeSendResult.Disabled, provider.saveResult("res-1"))
        assertEquals(PhoneBridgeSendResult.Disabled, provider.openOnPhone("res-1"))
        assertEquals(PhoneBridgeSendResult.Disabled, provider.retryScan("scan-1"))
        assertEquals(PhoneBridgeSendResult.Disabled, provider.cancelScan("scan-1"))
        provider.close() // must not throw
    }

    // ----- future real provider -----

    @Test
    fun `future real provider reports controlled bridge-unavailable state`() = runTest {
        val provider = FutureRealPhoneBridgeProvider()

        assertEquals(PhoneBridgeProviderStatus.UNAVAILABLE, provider.status.value)
        assertEquals(PhoneBridgeSendResult.Unavailable, provider.requestPairing())
        assertEquals(PhoneBridgeSendResult.Unavailable, provider.saveResult("res-1"))
        provider.close() // must not throw
    }

    // ----- mock provider: end-to-end exchange -----

    @Test
    fun `mock provider runs the full exchange over the raw transport`() = runTest(UnconfinedTestDispatcher()) {
        val provider = MockPhoneBridgeProvider.create(parentScope = this)
        val events = mutableListOf<PhoneBridgeEvent>()
        val collector = launch { provider.events.collect { events.add(it) } }

        try {
            // Pairing: mock approves; then the phone finishes the handshake.
            assertEquals(PhoneBridgeSendResult.Sent, provider.requestPairing())
            provider.companion.sendSessionReady()

            // Capture: request crosses the transport; mock answers started+completed.
            assertEquals(PhoneBridgeSendResult.Sent, provider.requestCapture())

            // Scan lifecycle + result.
            provider.companion.sendScanSequence(scanId = "scan-1", resultId = "res-1")
            provider.companion.sendResultShow("res-1")

            // Save ack arrives as result.update revision 1.
            assertEquals(PhoneBridgeSendResult.Sent, provider.saveResult("res-1", "Leather Biker Jacket"))

            assertEquals(PhoneBridgeProviderStatus.ACTIVE, provider.status.value)
            assertEquals(
                listOf(
                    PhoneBridgeEvent.PairApproved::class,
                    PhoneBridgeEvent.SessionReady::class,
                    PhoneBridgeEvent.CaptureStarted::class,
                    PhoneBridgeEvent.CaptureCompleted::class,
                    PhoneBridgeEvent.ScanProcessing::class,
                    PhoneBridgeEvent.ScanProgress::class,
                    PhoneBridgeEvent.ScanProgress::class,
                    PhoneBridgeEvent.ScanProgress::class,
                    PhoneBridgeEvent.ScanCompleted::class,
                    PhoneBridgeEvent.ResultShown::class,
                    PhoneBridgeEvent.ResultUpdated::class,
                ),
                events.map { it::class },
            )
            val approved = events.first() as PhoneBridgeEvent.PairApproved
            assertEquals("sess-1", approved.sessionId)
            val updated = events.last() as PhoneBridgeEvent.ResultUpdated
            assertEquals(1, updated.revision)
        } finally {
            collector.cancel()
            provider.close()
        }
    }

    @Test
    fun `mock provider reports failure events with safe codes`() = runTest(UnconfinedTestDispatcher()) {
        val provider = MockPhoneBridgeProvider.create(parentScope = this)
        val events = mutableListOf<PhoneBridgeEvent>()
        val collector = launch { provider.events.collect { events.add(it) } }

        try {
            provider.requestPairing()
            provider.companion.sendSessionReady()
            provider.companion.sendScanProcessing("scan-1")
            provider.companion.sendScanFailed("scan-1", ScanErrorCode.BACKEND_UNAVAILABLE)

            val failed = events.filterIsInstance<PhoneBridgeEvent.ScanFailed>().single()
            assertEquals(ScanErrorCode.BACKEND_UNAVAILABLE, failed.code)
        } finally {
            collector.cancel()
            provider.close()
        }
    }

    @Test
    fun `capture before pairing fails safe without sending`() = runTest(UnconfinedTestDispatcher()) {
        val provider = MockPhoneBridgeProvider.create(parentScope = this)
        try {
            // No session exists yet: controlled Unavailable, never a crash.
            assertEquals(PhoneBridgeSendResult.Unavailable, provider.requestCapture())
            assertEquals(PhoneBridgeSendResult.Unavailable, provider.saveResult("res-1"))
        } finally {
            provider.close()
        }
    }

    // ----- structured concurrency -----

    @Test
    fun `close cancels pending work and leaves the caller scope alive`() = runTest(UnconfinedTestDispatcher()) {
        val provider = MockPhoneBridgeProvider.create(
            parentScope = this,
            pairBehavior = MockPhoneCompanion.PairBehavior.HOLD_UNTIL_EXPIRY,
        )
        val collector = launch { provider.events.collect { } }

        // Pairing is pending (mock holds it); close must cancel everything the
        // provider launched — but not the caller's scope.
        provider.requestPairing()
        provider.close()
        collector.cancel()

        val ownJob = coroutineContext[Job]!!
        assertTrue(
            "provider coroutines must be cancelled by close()",
            ownJob.children.none { it.isActive },
        )
        assertTrue(ownJob.isActive)
    }

    @Test
    fun `connection loss flips status and leaks no coroutines`() = runTest(UnconfinedTestDispatcher()) {
        val provider = MockPhoneBridgeProvider.create(parentScope = this)
        val events = mutableListOf<PhoneBridgeEvent>()
        val collector = launch { provider.events.collect { events.add(it) } }

        provider.requestPairing()
        provider.companion.sendSessionReady()
        assertEquals(PhoneBridgeProviderStatus.ACTIVE, provider.status.value)

        // Link drops mid-session, then recovers.
        provider.companion.sendConnectionLost()
        assertEquals(PhoneBridgeProviderStatus.UNAVAILABLE, provider.status.value)
        provider.companion.sendConnectionRestored()
        assertEquals(PhoneBridgeProviderStatus.ACTIVE, provider.status.value)
        assertTrue(events.any { it is PhoneBridgeEvent.ConnectionLost })
        assertTrue(events.any { it is PhoneBridgeEvent.ConnectionRestored })

        collector.cancel()
        provider.close()

        assertTrue(
            "no provider coroutine may survive close()",
            coroutineContext[Job]!!.children.none { it.isActive },
        )
    }

    @Test
    fun `sends after close fail safe`() = runTest(UnconfinedTestDispatcher()) {
        val provider = MockPhoneBridgeProvider.create(parentScope = this)
        provider.requestPairing()
        provider.close()

        assertEquals(PhoneBridgeSendResult.Unavailable, provider.requestPairing())
        assertEquals(PhoneBridgeSendResult.Unavailable, provider.requestCapture())
    }
}
