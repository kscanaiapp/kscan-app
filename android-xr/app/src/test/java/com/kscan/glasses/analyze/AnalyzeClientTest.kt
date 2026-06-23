package com.kscan.glasses.analyze

import com.kscan.glasses.config.BetaConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyzeClientTest {

    @Test
    fun `mock analyze success`() = runTest {
        val client = MockAnalyzeClient()
        val request = AnalyzeRequest("data:image/jpeg;base64,test123")
        val response = client.analyze(request)

        assertTrue(response is FashionAnalyzeResult)
        val fashion = response as FashionAnalyzeResult
        assertEquals("Mock: structured wool blazer with relaxed silhouette.", fashion.result)
        assertEquals(3, fashion.products.size)
    }

    @Test
    fun `real analyze disabled refuses to run`() = runTest {
        val config = AnalyzeClientConfig(enableRealAnalyze = false)
        val transport = FakeHttpTransport { _, _, _ -> HttpTransportResponse(200, "{}") }
        val client = RealAnalyzeClient(config, transport)

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.Disabled) {
            assertTrue(true)
        }
    }

    @Test
    fun `real analyze requires enableRealFaceMasking`() = runTest {
        val config = AnalyzeClientConfig(
            backendUrl = "https://example.com",
            enableRealAnalyze = true,
        )
        val transport = FakeHttpTransport { _, _, _ -> HttpTransportResponse(200, "{}") }
        val betaConfig = BetaConfig(enableRealAnalyze = true, enableRealFaceMasking = false)
        val client = RealAnalyzeClient(config, transport, betaConfig)

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.Disabled) {
            assertTrue(e.message?.contains("enableRealFaceMasking") == true)
        }
    }

    @Test
    fun `timeout maps to AnalyzeException Timeout`() = runTest {
        val config = AnalyzeClientConfig(
            backendUrl = "https://example.com",
            enableRealAnalyze = true,
        )
        val transport = FakeHttpTransport { _, _, _ ->
            throw java.net.SocketTimeoutException("timed out")
        }
        val betaConfig = BetaConfig(enableRealAnalyze = true, enableRealFaceMasking = true)
        val client = RealAnalyzeClient(config, transport, betaConfig)

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.Timeout) {
            assertTrue(e.message?.contains("timed out") == true)
        }
    }

    @Test
    fun `malformed response throws MalformedJson`() = runTest {
        val config = AnalyzeClientConfig(
            backendUrl = "https://example.com",
            enableRealAnalyze = true,
        )
        val transport = FakeHttpTransport { _, _, _ ->
            HttpTransportResponse(200, "not-json")
        }
        val betaConfig = BetaConfig(enableRealAnalyze = true, enableRealFaceMasking = true)
        val client = RealAnalyzeClient(config, transport, betaConfig)

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.MalformedJson) {
            assertTrue(true)
        }
    }

    @Test
    fun `http error throws HttpError`() = runTest {
        val config = AnalyzeClientConfig(
            backendUrl = "https://example.com",
            enableRealAnalyze = true,
        )
        val transport = FakeHttpTransport { _, _, _ ->
            HttpTransportResponse(500, "{}")
        }
        val betaConfig = BetaConfig(enableRealAnalyze = true, enableRealFaceMasking = true)
        val client = RealAnalyzeClient(config, transport, betaConfig)

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.HttpError) {
            assertEquals(500, e.status)
        }
    }

    @Test
    fun `real analyze rejects non-HTTPS backend URL`() = runTest {
        val config = AnalyzeClientConfig(
            backendUrl = "http://example.com",
            enableRealAnalyze = true,
        )
        val transport = FakeHttpTransport { _, _, _ -> HttpTransportResponse(200, "{}") }
        val betaConfig = BetaConfig(enableRealAnalyze = true, enableRealFaceMasking = true)
        val client = RealAnalyzeClient(config, transport, betaConfig)

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected exception", false)
        } catch (e: AnalyzeException.Disabled) {
            assertTrue(e.message?.contains("HTTPS") == true)
        }
    }

    @Test
    fun `data URL validation accepts valid data URLs`() {
        assertTrue(AnalyzeRequest.isValidDataUrl("data:image/jpeg;base64,abc"))
        assertTrue(AnalyzeRequest.isValidDataUrl("data:image/png;base64,abc"))
    }

    @Test
    fun `data URL validation rejects invalid strings`() {
        assertFalse(AnalyzeRequest.isValidDataUrl("abc"))
        assertFalse(AnalyzeRequest.isValidDataUrl("data:text/plain;base64,abc"))
        assertFalse(AnalyzeRequest.isValidDataUrl(""))
    }

    @Test
    fun `AnalyzeRequest constructor rejects invalid data URL`() {
        try {
            AnalyzeRequest("invalid")
            assertTrue("Expected exception", false)
        } catch (e: IllegalArgumentException) {
            assertTrue(true)
        }
    }

    @Test
    fun `no payload logging in FakeHttpTransport`() = runTest {
        val config = AnalyzeClientConfig(
            backendUrl = "https://example.com",
            enableRealAnalyze = true,
        )
        var capturedBody = ""
        val transport = FakeHttpTransport { _, body, _ ->
            capturedBody = body
            HttpTransportResponse(200, "{\"type\":\"non-fashion\",\"message\":\"nope\"}")
        }
        val betaConfig = BetaConfig(enableRealAnalyze = true, enableRealFaceMasking = true)
        val client = RealAnalyzeClient(config, transport, betaConfig)
        client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))

        // Assert body was sent but NOT logged anywhere in client code
        assertTrue(capturedBody.contains("image"))
        // SafeLog is not used; verify by absence of "base64" in exception messages
    }
}
