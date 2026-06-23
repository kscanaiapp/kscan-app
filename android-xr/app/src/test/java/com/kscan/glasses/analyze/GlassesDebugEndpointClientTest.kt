package com.kscan.glasses.analyze

import com.kscan.glasses.state.FashionAnalyzeResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassesDebugEndpointClientTest {

    @Test
    fun `maps success response to FashionAnalyzeResult`() = runTest {
        val fakeTransport = FakeHttpTransport { _, _, headers ->
            assertTrue("Authorization header required", headers.containsKey("Authorization"))
            assertTrue("Bearer prefix required", headers["Authorization"]!!.startsWith("Bearer "))
            HttpTransportResponse(200, debugSuccessJson)
        }

        val client = GlassesDebugEndpointClient(
            endpointUrl = "http://127.0.0.1:3999/api/glasses/analyze-debug",
            authToken = "test-token",
            transport = fakeTransport,
        )

        val response = client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))

        assertTrue(response is FashionAnalyzeResult)
        val fashion = response as FashionAnalyzeResult
        assertEquals("Mock Fashion Analysis — This is a safe mock response for the glasses smoke test.", fashion.result)
        assertEquals("jacket", fashion.category)
        assertEquals("black", fashion.color)
        assertEquals("oversized", fashion.silhouette)
        assertTrue(fashion.products.isEmpty())
    }

    @Test
    fun `maps error response to HttpError exception`() = runTest {
        val fakeTransport = FakeHttpTransport { _, _, _ ->
            HttpTransportResponse(401, debugErrorJson)
        }

        val client = GlassesDebugEndpointClient(
            endpointUrl = "http://127.0.0.1:3999/api/glasses/analyze-debug",
            authToken = "bad-token",
            transport = fakeTransport,
        )

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.HttpError) {
            assertEquals(401, e.status)
            assertTrue(e.message?.contains("UNAUTHORIZED") == true)
        }
    }

    @Test
    fun `maps malformed json to MalformedJson exception`() = runTest {
        val fakeTransport = FakeHttpTransport { _, _, _ ->
            HttpTransportResponse(200, "not-json")
        }

        val client = GlassesDebugEndpointClient(
            endpointUrl = "http://127.0.0.1:3999/api/glasses/analyze-debug",
            authToken = "test-token",
            transport = fakeTransport,
        )

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.MalformedJson) {
            assertTrue(true)
        }
    }

    @Test
    fun `maps network error to Network exception`() = runTest {
        val fakeTransport = FakeHttpTransport { _, _, _ ->
            throw java.io.IOException("Connection refused")
        }

        val client = GlassesDebugEndpointClient(
            endpointUrl = "http://127.0.0.1:3999/api/glasses/analyze-debug",
            authToken = "test-token",
            transport = fakeTransport,
        )

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.Network) {
            assertTrue(e.message?.contains("Connection refused") == true)
        }
    }

    @Test
    fun `maps timeout to Timeout exception`() = runTest {
        val fakeTransport = FakeHttpTransport { _, _, _ ->
            throw java.net.SocketTimeoutException("timed out")
        }

        val client = GlassesDebugEndpointClient(
            endpointUrl = "http://127.0.0.1:3999/api/glasses/analyze-debug",
            authToken = "test-token",
            transport = fakeTransport,
        )

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.Timeout) {
            assertTrue(true)
        }
    }

    @Test
    fun `response body never contains base64 or data image in mapped result`() = runTest {
        val fakeTransport = FakeHttpTransport { _, body, _ ->
            // The body should contain the data URL (this is the transport layer)
            // But the mapped result should NOT contain it
            assertTrue(body.contains("data:image/jpeg;base64,abc"))
            HttpTransportResponse(200, debugSuccessJson)
        }

        val client = GlassesDebugEndpointClient(
            endpointUrl = "http://127.0.0.1:3999/api/glasses/analyze-debug",
            authToken = "test-token",
            transport = fakeTransport,
        )

        val response = client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
        val json = response.toString()
        assertFalse("base64 should not appear in mapped result", json.contains("base64"))
        assertFalse("data:image should not appear in mapped result", json.contains("data:image"))
    }

    @Test
    fun `handles missing optional attributes gracefully`() = runTest {
        val partialJson = """
        {
            "ok": true,
            "requestId": "req-1",
            "result": {
                "title": "Minimal",
                "summary": "",
                "confidence": 0.0,
                "attributes": [],
                "suggestions": [],
                "safeForHud": true
            },
            "meta": { "source": "debug", "mode": "test", "model": "mock" }
        }
        """.trimIndent()

        val fakeTransport = FakeHttpTransport { _, _, _ ->
            HttpTransportResponse(200, partialJson)
        }

        val client = GlassesDebugEndpointClient(
            endpointUrl = "http://127.0.0.1:3999/api/glasses/analyze-debug",
            authToken = "test-token",
            transport = fakeTransport,
        )

        val response = client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
        assertTrue(response is FashionAnalyzeResult)
        val fashion = response as FashionAnalyzeResult
        assertEquals("Minimal", fashion.result)
        assertEquals("", fashion.category)
        assertEquals("", fashion.color)
        assertEquals("", fashion.silhouette)
    }

    companion object {
        private val debugSuccessJson = """
        {
            "ok": true,
            "requestId": "test-req-1",
            "result": {
                "title": "Mock Fashion Analysis",
                "summary": "This is a safe mock response for the glasses smoke test.",
                "confidence": 0.0,
                "attributes": [
                    { "name": "category", "value": "jacket" },
                    { "name": "color", "value": "black" },
                    { "name": "silhouette", "value": "oversized" }
                ],
                "suggestions": ["Pair with slim jeans for a clean look."],
                "safeForHud": true
            },
            "meta": { "source": "debug-backend", "mode": "debug", "model": "mock-debug" }
        }
        """.trimIndent()

        private val debugErrorJson = """
        {
            "ok": false,
            "requestId": "test-req-2",
            "error": {
                "code": "UNAUTHORIZED",
                "message": "Authentication failed."
            }
        }
        """.trimIndent()
    }
}
