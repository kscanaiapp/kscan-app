package com.kscan.glasses.phonebridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Wire codec for the versioned phone bridge.
 *
 * Frames are raw JSON strings. The codec enforces the byte ceiling on encode
 * (callers sending to a real transport always use the default; the mock
 * companion may bypass it to exercise the validator's PAYLOAD_TOO_LARGE path).
 * Decode is intentionally lenient about nothing: malformed frames throw, and
 * the validator is responsible for mapping that to a safe reject code.
 */
object PhoneBridgeCodec {

    val json: Json = Json {
        classDiscriminator = "messageType"
        // Strict: unknown fields are a contract violation, not a hint.
        ignoreUnknownKeys = false
        // Always emit envelope defaults (protocolVersion, expiresAt) so the
        // wire shape is stable and probe order is deterministic.
        encodeDefaults = true
    }

    /**
     * Serializes [message] to a JSON frame.
     *
     * @throws PhoneBridgeMessageTooLargeException if the UTF-8 frame exceeds
     *   [PhoneBridgeProtocol.MAX_MESSAGE_BYTES] and [enforceCeiling] is true.
     */
    fun encode(message: PhoneBridgeMessage, enforceCeiling: Boolean = true): String {
        val frame = json.encodeToString(PhoneBridgeMessage.serializer(), message)
        if (enforceCeiling && frame.toByteArray(Charsets.UTF_8).size > PhoneBridgeProtocol.MAX_MESSAGE_BYTES) {
            throw PhoneBridgeMessageTooLargeException()
        }
        return frame
    }

    /**
     * Parses a JSON frame into a typed message.
     *
     * @throws IllegalArgumentException / SerializationException on any
     *   malformed, untyped, or contract-violating frame. Callers must not
     *   surface exception text to users or logs.
     */
    fun decode(raw: String): PhoneBridgeMessage =
        json.decodeFromString(PhoneBridgeMessage.serializer(), raw)

    /**
     * Structural pre-parse for the validator: returns the frame as a
     * [JsonObject], or null when the frame is not valid JSON or not an object.
     * Never throws.
     */
    fun probe(raw: String): JsonObject? =
        runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
}

/** Internal signal that an outbound frame exceeded the wire ceiling. */
internal class PhoneBridgeMessageTooLargeException : IllegalArgumentException("frame exceeds MAX_MESSAGE_BYTES")
