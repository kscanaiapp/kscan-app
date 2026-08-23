package com.kscan.glasses.phonebridge

import com.kscan.glasses.scan.ScanErrorCode
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Wire-contract coverage for the versioned phone bridge: round-trip per
 * family, stable discriminator values, ceiling/version constants, and the
 * result-first guarantee (no image bytes, tokens, or credentials on the wire).
 */
class PhoneBridgeContractTest {

    private companion object {
        const val NOW = 1_700_000_000_000L
        const val GLASSES_ID = "glasses-1"
        const val PHONE_ID = "phone-1"
        const val SESSION_ID = "sess-1"
    }

    private fun sampleResult(resultId: String = "res-1") = ResultPayload(
        resultId = resultId,
        summary = "Vintage black leather jacket",
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
                thumbnailUrl = null,
            ),
        ),
        availableActions = listOf(ResultAction.SAVE, ResultAction.OPEN_ON_PHONE),
        scanStatus = ScanStatus.COMPLETED,
    )

    /** One representative message per wire type (26 types, 7 families). */
    private fun allMessages(): List<PhoneBridgeMessage> = listOf(
        // pair.*
        PhoneBridgeMessage.PairRequest(
            requestId = "req-pair", deviceId = GLASSES_ID, timestamp = NOW,
            payload = PairRequestPayload(model = "KScan Glasses", appVersion = "1.0.0"),
        ),
        PhoneBridgeMessage.PairApproved(
            requestId = "req-pair", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = PairApprovedPayload(sessionExpiresAt = NOW + 60_000L),
        ),
        PhoneBridgeMessage.PairDenied(
            requestId = "req-pair", sessionId = PhoneBridgeProtocol.NO_SESSION, deviceId = PHONE_ID, timestamp = NOW,
            payload = PairDeniedPayload(reason = PairDenyReason.USER_REJECTED),
        ),
        PhoneBridgeMessage.PairExpired(
            requestId = "req-pair", sessionId = PhoneBridgeProtocol.NO_SESSION, deviceId = PHONE_ID, timestamp = NOW,
        ),
        // session.*
        PhoneBridgeMessage.SessionReady(
            requestId = "req-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = SessionReadyPayload(phoneAppVersion = "1.0.0", features = listOf("scan", "save")),
        ),
        PhoneBridgeMessage.SessionRevoked(
            requestId = "req-2", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = SessionRevokedPayload(reason = SessionRevokeReason.USER_REVOKED),
        ),
        PhoneBridgeMessage.SessionError(
            requestId = "req-3", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = SessionErrorPayload(code = ScanErrorCode.BACKEND_UNAVAILABLE.name, recoverable = true),
        ),
        // capture.*
        PhoneBridgeMessage.CaptureRequest(
            requestId = "req-4", sessionId = SESSION_ID, deviceId = GLASSES_ID, timestamp = NOW,
            payload = CaptureRequestPayload(preference = CapturePreference.AUTO),
        ),
        PhoneBridgeMessage.CaptureStarted(
            requestId = "req-4", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = CaptureStartedPayload(captureId = "cap-1"),
        ),
        PhoneBridgeMessage.CaptureCompleted(
            requestId = "req-4", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = CaptureCompletedPayload(captureId = "cap-1", captureRef = "ref-cap-1"),
        ),
        PhoneBridgeMessage.CaptureFailed(
            requestId = "req-4", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = CaptureFailedPayload(captureId = "cap-1", code = ScanErrorCode.CAPTURE_UNAVAILABLE),
        ),
        // scan.*
        PhoneBridgeMessage.ScanProcessing(
            requestId = "req-5", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ScanProcessingPayload(scanId = "scan-1"),
        ),
        PhoneBridgeMessage.ScanProgress(
            requestId = "req-6", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ScanProgressPayload(scanId = "scan-1", stage = ScanStage.ANALYZING, percent = 60),
        ),
        PhoneBridgeMessage.ScanCompleted(
            requestId = "req-7", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ScanCompletedPayload(scanId = "scan-1", resultId = "res-1"),
        ),
        PhoneBridgeMessage.ScanFailed(
            requestId = "req-8", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ScanFailedPayload(scanId = "scan-1", code = ScanErrorCode.NON_FASHION),
        ),
        // result.*
        PhoneBridgeMessage.ResultShow(
            requestId = "req-9", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ResultShowPayload(result = sampleResult()),
        ),
        PhoneBridgeMessage.ResultUpdate(
            requestId = "req-10", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ResultUpdatePayload(result = sampleResult(), revision = 1),
        ),
        PhoneBridgeMessage.ResultDismiss(
            requestId = "req-11", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ResultDismissPayload(resultId = "res-1"),
        ),
        // action.*
        PhoneBridgeMessage.ActionSave(
            requestId = "req-12", sessionId = SESSION_ID, deviceId = GLASSES_ID, timestamp = NOW,
            payload = ActionSavePayload(resultId = "res-1", productTitle = "Leather Biker Jacket", actionId = "save:res-1"),
        ),
        PhoneBridgeMessage.ActionOpenOnPhone(
            requestId = "req-13", sessionId = SESSION_ID, deviceId = GLASSES_ID, timestamp = NOW,
            payload = ActionOpenOnPhonePayload(resultId = "res-1", actionId = "open:res-1"),
        ),
        PhoneBridgeMessage.ActionRetry(
            requestId = "req-14", sessionId = SESSION_ID, deviceId = GLASSES_ID, timestamp = NOW,
            payload = ActionRetryPayload(scanId = "scan-1"),
        ),
        PhoneBridgeMessage.ActionCancel(
            requestId = "req-15", sessionId = SESSION_ID, deviceId = GLASSES_ID, timestamp = NOW,
            payload = ActionCancelPayload(scanId = "scan-1"),
        ),
        // connection.*
        PhoneBridgeMessage.ConnectionPing(
            requestId = "req-16", sessionId = SESSION_ID, deviceId = GLASSES_ID, timestamp = NOW,
            payload = ConnectionPingPayload(nonce = "n-1"),
        ),
        PhoneBridgeMessage.ConnectionPong(
            requestId = "req-17", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ConnectionPongPayload(nonce = "n-1"),
        ),
        PhoneBridgeMessage.ConnectionLost(
            requestId = "req-18", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ConnectionLostPayload(reason = ConnectionLostReason.TRANSPORT_LOST),
        ),
        PhoneBridgeMessage.ConnectionRestored(
            requestId = "req-19", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
        ),
    )

    @Test
    fun `every message type round-trips through the codec`() {
        val messages = allMessages()
        assertEquals(26, messages.size)
        for (message in messages) {
            val frame = PhoneBridgeCodec.encode(message)
            val decoded = PhoneBridgeCodec.decode(frame)
            assertEquals(message, decoded)
        }
    }

    @Test
    fun `every message type carries a stable dot-namespaced discriminator`() {
        val expectedFamilies = mapOf(
            "pair" to 4, "session" to 3, "capture" to 4,
            "scan" to 4, "result" to 3, "action" to 4, "connection" to 4,
        )
        val seen = mutableMapOf<String, Int>()
        for (message in allMessages()) {
            val frame = PhoneBridgeCodec.encode(message)
            val discriminator = PhoneBridgeCodec.probe(frame)
                ?.get("messageType")
                ?.jsonPrimitive
                ?.content
            assertEquals(message.messageType, discriminator)
            val family = discriminator!!.substringBefore('.')
            assertTrue("unknown family: $family", family in expectedFamilies)
            seen[family] = (seen[family] ?: 0) + 1
        }
        assertEquals(expectedFamilies, seen)
    }

    @Test
    fun `no serialized frame carries image data or credential markers`() {
        val forbidden = listOf("base64", "data:image", "bearer", "token")
        for (message in allMessages()) {
            val frame = PhoneBridgeCodec.encode(message).lowercase()
            for (marker in forbidden) {
                assertFalse(
                    "${message.messageType} frame must not contain '$marker'",
                    frame.contains(marker),
                )
            }
        }
    }

    @Test
    fun `protocol constants match the locked values`() {
        assertEquals(1, PhoneBridgeProtocol.PROTOCOL_VERSION)
        assertEquals(65_536, PhoneBridgeProtocol.MAX_MESSAGE_BYTES)
        assertTrue(PhoneBridgeProtocol.MAX_MESSAGE_BYTES < 100 * 1024)
        assertEquals(30_000L, PhoneBridgeProtocol.TIMESTAMP_TOLERANCE_MS)
        assertEquals("", PhoneBridgeProtocol.NO_SESSION)
    }

    @Test
    fun `encoder rejects frames past the byte ceiling`() {
        val oversized = PhoneBridgeMessage.ResultShow(
            requestId = "req-big", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            payload = ResultShowPayload(
                result = sampleResult().copy(
                    summary = "x".repeat(PhoneBridgeProtocol.MAX_MESSAGE_BYTES),
                ),
            ),
        )
        try {
            PhoneBridgeCodec.encode(oversized)
            fail("expected PhoneBridgeMessageTooLargeException")
        } catch (_: PhoneBridgeMessageTooLargeException) {
            // expected
        }

        // The ceiling bypass exists only for validator exercise (mock companion).
        val frame = PhoneBridgeCodec.encode(oversized, enforceCeiling = false)
        assertTrue(frame.toByteArray(Charsets.UTF_8).size > PhoneBridgeProtocol.MAX_MESSAGE_BYTES)
    }

    @Test
    fun `empty payload serializes as an empty object`() {
        val frame = PhoneBridgeCodec.encode(
            PhoneBridgeMessage.ConnectionRestored(
                requestId = "req-1", sessionId = SESSION_ID, deviceId = PHONE_ID, timestamp = NOW,
            ),
        )
        val payload = PhoneBridgeCodec.probe(frame)
            ?.get("payload")
            ?.jsonObject
        assertEquals(0, payload?.size)
    }

    @Test
    fun `envelope defaults are always present on the wire`() {
        val frame = PhoneBridgeCodec.encode(
            PhoneBridgeMessage.PairRequest(
                requestId = "req-pair", deviceId = GLASSES_ID, timestamp = NOW,
                payload = PairRequestPayload(model = "KScan Glasses", appVersion = "1.0.0"),
            ),
        )
        val obj = PhoneBridgeCodec.probe(frame)!!
        assertEquals(1, obj["protocolVersion"]!!.jsonPrimitive.content.toInt())
        assertEquals("", obj["sessionId"]!!.jsonPrimitive.content)
        assertTrue(obj.containsKey("expiresAt"))
        assertTrue(obj.containsKey("timestamp"))
        assertTrue(obj.containsKey("deviceId"))
        assertTrue(obj.containsKey("requestId"))
    }
}
