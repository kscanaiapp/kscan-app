package com.kscan.glasses.analyze

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 3C — Host-side controlled live backend smoke test.
 *
 * This test exercises the [GlassesDebugEndpointClient] against the local
 * backend debug endpoint (POST /api/glasses/analyze-debug) using the real
 * [KscanHttpTransport].
 *
 * ## Running this test
 *
 * 1. Start the local backend server (from repo root):
 *    ```bash
 *    cd backend
 *    KSCAN_GLASSES_ANALYZE_ENABLED=true \
 *    KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN=test-local-token \
 *    KSCAN_GLASSES_ANALYZE_MODEL=mock-debug \
 *    node server.js
 *    ```
 *    The server listens on port 3002 by default (or KSCAN_GLASSES_PORT).
 *
 * 2. Run this test with the environment variable:
 *    ```bash
 *    KSCAN_PHASE3C_LOCAL_SMOKE=true \
 *    KSCAN_PHASE3C_BACKEND_URL=http://127.0.0.1:3002/api/glasses/analyze-debug \
 *    KSCAN_PHASE3C_AUTH_TOKEN=test-local-token \
 *    ./gradlew :app:testDebugUnitTest \
 *      --tests "com.kscan.glasses.analyze.Phase3CLocalBackendSmokeTest"
 *    ```
 *
 * 3. If the backend is not running, the test will fail with a clear message
 *    indicating the server needs to be started.
 *
 * ## Safety
 *
 * * This test is **disabled by default** unless `KSCAN_PHASE3C_LOCAL_SMOKE=true`.
 * * No emulator or hardware is required.
 * * No production/staging backend is called.
 * * No external model/API is called.
 * * No image payload, token, or raw response is logged by test code.
 * * The test sends exactly one tiny fake JPEG data URL.
 */
class Phase3CLocalBackendSmokeTest {

    private val isEnabled: Boolean
        get() = System.getenv("KSCAN_PHASE3C_LOCAL_SMOKE")?.toBoolean() ?: false

    private val backendUrl: String
        get() = System.getenv("KSCAN_PHASE3C_BACKEND_URL")
            ?: "http://127.0.0.1:3002/api/glasses/analyze-debug"

    private val authToken: String
        get() = System.getenv("KSCAN_PHASE3C_AUTH_TOKEN") ?: "test-local-token"

    @Test
    fun `phase 3C local backend smoke test`() = runTest {
        if (!isEnabled) {
            println(
                "SKIP: Phase 3C smoke test is disabled by default. " +
                "Set KSCAN_PHASE3C_LOCAL_SMOKE=true to enable. " +
                "Ensure the local backend is running first."
            )
            return@runTest
        }

        println("Phase 3C: Connecting to local backend at $backendUrl")

        val client = GlassesDebugEndpointClient(
            endpointUrl = backendUrl,
            authToken = authToken,
            transport = KscanHttpTransport(),
        )

        val response = try {
            client.analyze(
                AnalyzeRequest("data:image/jpeg;base64,abc")
            )
        } catch (e: Exception) {
            // Provide a helpful failure message so the runner knows
            // the backend probably isn't started.
            throw AssertionError(
                "Phase 3C smoke test failed to connect to local backend. " +
                "Ensure the backend server is running on the expected port. " +
                "Cause: ${e.javaClass.simpleName}: ${e.message}",
                e,
            )
        }

        // 1. Assert response type
        assertTrue(
            "Expected FashionAnalyzeResult, got ${response::class.simpleName}",
            response is com.kscan.glasses.state.FashionAnalyzeResult,
        )

        val fashion = response as com.kscan.glasses.state.FashionAnalyzeResult

        // 2. Assert HUD-safe fields are present
        assertTrue("Result text should not be empty", fashion.result.isNotBlank())

        // 3. Assert no payload leakage in mapped result
        val resultJson = fashion.toString()
        assertFalse(
            "Mapped result should not contain base64",
            resultJson.contains("base64"),
        )
        assertFalse(
            "Mapped result should not contain data:image",
            resultJson.contains("data:image"),
        )

        // 4. Assert the mock endpoint returned expected shape
        // (title + summary mapping from debug endpoint mock)
        assertTrue(
            "Result should contain expected mock title",
            fashion.result.contains("Mock Fashion Analysis"),
        )

        println("Phase 3C: Smoke test passed. Result: ${fashion.result}")
    }

    @Test
    fun `phase 3C local backend returns safe error when token is wrong`() = runTest {
        if (!isEnabled) {
            println("SKIP: Phase 3C smoke test disabled. Set KSCAN_PHASE3C_LOCAL_SMOKE=true.")
            return@runTest
        }

        val client = GlassesDebugEndpointClient(
            endpointUrl = backendUrl,
            authToken = "wrong-token",
            transport = KscanHttpTransport(),
        )

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected HttpError for bad token", false)
        } catch (e: AnalyzeException.HttpError) {
            assertEquals(401, e.status)
            assertTrue(e.message?.contains("UNAUTHORIZED") == true)
        }
    }

    @Test
    fun `phase 3C backend unavailable maps to safe failure`() = runTest {
        if (!isEnabled) {
            println("SKIP: Phase 3C smoke test disabled.")
            return@runTest
        }

        // Use a port that is very unlikely to be open (different from backend port)
        val unavailableUrl = "http://127.0.0.1:1/api/glasses/analyze-debug"
        val client = GlassesDebugEndpointClient(
            endpointUrl = unavailableUrl,
            authToken = authToken,
            transport = KscanHttpTransport(),
        )

        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected Network exception for unavailable backend", false)
        } catch (e: AnalyzeException.Network) {
            // Expected — backend is not available on port 1
            assertTrue(true)
        }
    }
}
