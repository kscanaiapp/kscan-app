package com.kscan.glasses.phonebridge

import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RealKScanPhoneBridgeProviderTest {
    @Test
    fun `real provider pairs with one-time ticket then sends session-bound capture`() = runTest {
        var now = 10_000L
        val api = FakeApi(clock = { now })
        val provider = RealKScanPhoneBridgeProvider(
            api = api,
            glassesDeviceId = GLASSES_ID,
            appVersion = "0.2.0-test",
            parentScope = backgroundScope,
            clock = { now },
            pollIntervalMs = 1,
        )
        val events = backgroundScope.async { provider.events.take(2).toList() }

        assertEquals(PhoneBridgeSendResult.Sent, provider.requestPairing())
        assertEquals("417203", provider.pairingCode.value)
        advanceTimeBy(2)
        runCurrent()

        val paired = events.await()
        assertTrue(paired[0] is PhoneBridgeEvent.PairApproved)
        assertTrue(paired[1] is PhoneBridgeEvent.SessionReady)
        assertEquals(null, provider.pairingCode.value)

        now += 5
        assertEquals(PhoneBridgeSendResult.Sent, provider.requestCapture(CapturePreference.PHONE))
        val sent = PhoneBridgeCodec.decode(api.sentFrames.single()) as PhoneBridgeMessage.CaptureRequest
        assertEquals(SESSION_ID, sent.sessionId)
        assertEquals(CapturePreference.PHONE, sent.payload.preference)
        provider.close()
    }

    @Test
    fun `actions fail closed before pairing and after close`() = runTest {
        val provider = RealKScanPhoneBridgeProvider(
            api = FakeApi { 10_000L }, glassesDeviceId = GLASSES_ID,
            appVersion = "test", parentScope = backgroundScope, clock = { 10_000L }, pollIntervalMs = 1,
        )
        assertEquals(PhoneBridgeSendResult.Unavailable, provider.saveResult(UUID.randomUUID().toString()))
        provider.close()
        assertEquals(PhoneBridgeSendResult.Unavailable, provider.requestPairing())
    }

    private class FakeApi(private val clock: () -> Long) : WearableBridgeApi {
        lateinit var pairRequest: PhoneBridgeMessage.PairRequest
        val sentFrames = mutableListOf<String>()
        override suspend fun createPairing(frame: String): PairingTicket {
            pairRequest = PhoneBridgeCodec.decode(frame) as PhoneBridgeMessage.PairRequest
            return PairingTicket("handle", "417203", "pair-secret", clock() + 60_000)
        }
        override suspend fun pollPairing(pairingHandle: String, pairingSecret: String, after: Long): BridgePoll {
            val expires = clock() + 30_000
            return BridgePoll(
                frames = listOf(
                    PhoneBridgeCodec.encode(PhoneBridgeMessage.PairApproved(
                        requestId = pairRequest.requestId, sessionId = SESSION_ID, deviceId = PHONE_ID,
                        timestamp = clock(), payload = PairApprovedPayload(expires),
                    )),
                    PhoneBridgeCodec.encode(PhoneBridgeMessage.SessionReady(
                        requestId = UUID.randomUUID().toString(), sessionId = SESSION_ID, deviceId = PHONE_ID,
                        timestamp = clock(), payload = SessionReadyPayload("phone-test", listOf("phone_capture")),
                    )),
                ),
                wearableToken = "wearable-token-with-sufficient-length-123456",
            )
        }
        override suspend fun send(wearableToken: String, frame: String) { sentFrames += frame }
        override suspend fun poll(wearableToken: String, after: Long): BridgePoll = BridgePoll(cursor = after)
    }

    companion object {
        private const val GLASSES_ID = "11111111-1111-4111-8111-111111111111"
        private const val PHONE_ID = "22222222-2222-4222-8222-222222222222"
        private const val SESSION_ID = "33333333-3333-4333-8333-333333333333"
    }
}
