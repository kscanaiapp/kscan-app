package com.kscan.glasses.analyze

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Contract tests for the glasses debug analyze request body.
 * The backend validator (backend/middleware/validateGlassesAnalyzeRequest.js)
 * requires: image = non-empty JPEG data URL string; client = "google-glasses-alpha".
 */
class AnalyzeRequestJsonTest {

    private val parser = Json

    @Test
    fun `emitted body parses as valid JSON`() {
        val body = AnalyzeRequestJson.encodeGlassesDebugRequest("data:image/jpeg;base64,abc")
        val json = parser.parseToJsonElement(body).jsonObject
        assertEquals(2, json.keys.size)
    }

    @Test
    fun `image field is a JSON string carrying the data URL`() {
        val dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
        val json = parser.parseToJsonElement(
            AnalyzeRequestJson.encodeGlassesDebugRequest(dataUrl),
        ).jsonObject
        assertTrue(json["image"]!!.jsonPrimitive.isString)
        assertEquals(dataUrl, json["image"]!!.jsonPrimitive.content)
        assertTrue(json["image"]!!.jsonPrimitive.content.startsWith("data:image/jpeg;base64,"))
    }

    @Test
    fun `client field equals google-glasses-alpha`() {
        val json = parser.parseToJsonElement(
            AnalyzeRequestJson.encodeGlassesDebugRequest("data:image/jpeg;base64,abc"),
        ).jsonObject
        assertEquals("google-glasses-alpha", json["client"]!!.jsonPrimitive.content)
    }

    @Test
    fun `quotes backslashes and control characters are escaped correctly`() {
        val hostile = "data:image/jpeg;base64,\"quoted\" \\ backslash \n newline \t tab ‡"
        val body = AnalyzeRequestJson.encodeGlassesDebugRequest(hostile)
        val json = parser.parseToJsonElement(body).jsonObject
        // Round-trip: the decoded string must equal the original exactly.
        assertEquals(hostile, json["image"]!!.jsonPrimitive.content)
        // Raw control characters must not appear unescaped in the encoded body.
        assertFalse(body.contains("\n"))
        assertFalse(body.contains("\t"))
    }

    @Test
    fun `unicode and emoji survive round trip`() {
        val dataUrl = "data:image/jpeg;base64,abc//+==ültï-bytes-✓"
        val json = parser.parseToJsonElement(
            AnalyzeRequestJson.encodeGlassesDebugRequest(dataUrl),
        ).jsonObject
        assertEquals(dataUrl, json["image"]!!.jsonPrimitive.content)
    }

    @Test
    fun `client id constant matches the documented backend contract`() {
        assertEquals("google-glasses-alpha", AnalyzeRequestJson.GLASSES_DEBUG_CLIENT_ID)
    }

    @Test
    fun `upstream body uses bare base64 without data URL prefix`() {
        val dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
        val json = parser.parseToJsonElement(
            AnalyzeRequestJson.encodeUpstreamAnalyzeRequest(dataUrl),
        ).jsonObject
        assertEquals(1, json.keys.size)
        assertEquals("/9j/4AAQSkZJRg==", json["image"]!!.jsonPrimitive.content)
        assertFalse(json["image"]!!.jsonPrimitive.content.startsWith("data:"))
    }

    @Test
    fun `upstream encoder preserves already-bare base64`() {
        val bare = "abc123+/=="
        val json = parser.parseToJsonElement(
            AnalyzeRequestJson.encodeUpstreamAnalyzeRequest(bare),
        ).jsonObject
        assertEquals(bare, json["image"]!!.jsonPrimitive.content)
    }

    @Test
    fun `toBareBase64 strips only the data URL prefix`() {
        assertEquals("abc", AnalyzeRequestJson.toBareBase64("data:image/jpeg;base64,abc"))
        assertEquals("abc", AnalyzeRequestJson.toBareBase64("data:image/png;base64,abc"))
        assertEquals("already", AnalyzeRequestJson.toBareBase64("already"))
    }
}
