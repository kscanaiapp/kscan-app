package com.kscan.glasses.phonebridge

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Wire-envelope contract for the four outbound action frames
 * (action.save / action.open_on_phone / action.retry / action.cancel).
 *
 * The frames are built exactly as MockPhoneBridgeProvider builds them and are
 * passed through a glasses-side validator (which registers correlation state,
 * exactly like the provider's send path), then probed as raw JSON: every frame
 * must carry the full versioned envelope and reference ids only — no image
 * bytes, tokens, or credentials.
 */
class OutboundActionEnvelopeTest {

    private companion object {
        const val GLASSES_ID = "glasses-1"
        const val SESSION_ID = "sess-1"
        const val T0 = 1_700_000_000_000L
    }

    private val validator = PhoneBridgeValidator(GLASSES_ID) { T0 }

    private fun encodeAction(message: PhoneBridgeMessage): String = validator.validateOutgoing(message)

    private fun probeKeys(frame: String) =
        PhoneBridgeCodec.probe(frame) ?: error("frame is not a JSON object")

    private fun assertEnvelope(frame: String, expectedType: String, expectedPayloadKey: String) {
        val probe = probeKeys(frame)
        assertEquals(expectedType, probe.getValue("messageType").jsonPrimitive.content)
        assertEquals(PhoneBridgeProtocol.PROTOCOL_VERSION, probe.getValue("protocolVersion").jsonPrimitive.content.toInt())
        assertTrue(probe.getValue("requestId").jsonPrimitive.content.isNotBlank())
        assertEquals(SESSION_ID, probe.getValue("sessionId").jsonPrimitive.content)
        assertEquals(GLASSES_ID, probe.getValue("deviceId").jsonPrimitive.content)
        assertEquals(T0, probe.getValue("timestamp").jsonPrimitive.content.toLong())
        assertNotNull(probe["expiresAt"]) // stable wire shape; may be null-valued
        val payload = probe.getValue("payload").jsonObject
        assertTrue("payload carries $expectedPayloadKey", payload[expectedPayloadKey] is JsonPrimitive)
        // References only: the envelope never carries secrets or media.
        val frameLower = frame.lowercase()
        assertTrue(!frameLower.contains("base64"))
        assertTrue(!frameLower.contains("token"))
        assertTrue(!frameLower.contains("password"))
        // Round-trip: the frame decodes back to the same typed message.
        assertEquals(expectedType, PhoneBridgeCodec.decode(frame).messageType)
        // Within the wire ceiling.
        assertTrue(frame.toByteArray(Charsets.UTF_8).size <= PhoneBridgeProtocol.MAX_MESSAGE_BYTES)
    }

    @Test
    fun `action save frame carries the full envelope and result reference`() {
        val frame = encodeAction(
            PhoneBridgeMessage.ActionSave(
                requestId = "glasses-req-1",
                sessionId = SESSION_ID,
                deviceId = GLASSES_ID,
                timestamp = T0,
                payload = ActionSavePayload(resultId = "res-1", productTitle = "Leather Biker Jacket", actionId = "save:res-1"),
            ),
        )

        assertEnvelope(frame, PhoneBridgeProtocol.TYPE_ACTION_SAVE, "resultId")
        val payload = probeKeys(frame).getValue("payload").jsonObject
        assertEquals("res-1", payload.getValue("resultId").jsonPrimitive.content)
        assertEquals("Leather Biker Jacket", payload.getValue("productTitle").jsonPrimitive.content)
    }

    @Test
    fun `action open on phone frame carries the full envelope and result reference`() {
        val frame = encodeAction(
            PhoneBridgeMessage.ActionOpenOnPhone(
                requestId = "glasses-req-2",
                sessionId = SESSION_ID,
                deviceId = GLASSES_ID,
                timestamp = T0,
                payload = ActionOpenOnPhonePayload(resultId = "res-1", actionId = "open:res-1"),
            ),
        )

        assertEnvelope(frame, PhoneBridgeProtocol.TYPE_ACTION_OPEN_ON_PHONE, "resultId")
        val payload = probeKeys(frame).getValue("payload").jsonObject
        assertEquals("res-1", payload.getValue("resultId").jsonPrimitive.content)
    }

    @Test
    fun `action retry frame carries the full envelope and scan reference`() {
        val frame = encodeAction(
            PhoneBridgeMessage.ActionRetry(
                requestId = "glasses-req-3",
                sessionId = SESSION_ID,
                deviceId = GLASSES_ID,
                timestamp = T0,
                payload = ActionRetryPayload(scanId = "scan-1"),
            ),
        )

        assertEnvelope(frame, PhoneBridgeProtocol.TYPE_ACTION_RETRY, "scanId")
        val payload = probeKeys(frame).getValue("payload").jsonObject
        assertEquals("scan-1", payload.getValue("scanId").jsonPrimitive.content)
    }

    @Test
    fun `action cancel frame carries the full envelope and scan reference`() {
        val frame = encodeAction(
            PhoneBridgeMessage.ActionCancel(
                requestId = "glasses-req-4",
                sessionId = SESSION_ID,
                deviceId = GLASSES_ID,
                timestamp = T0,
                payload = ActionCancelPayload(scanId = "scan-1"),
            ),
        )

        assertEnvelope(frame, PhoneBridgeProtocol.TYPE_ACTION_CANCEL, "scanId")
        val payload = probeKeys(frame).getValue("payload").jsonObject
        assertEquals("scan-1", payload.getValue("scanId").jsonPrimitive.content)
    }
}
