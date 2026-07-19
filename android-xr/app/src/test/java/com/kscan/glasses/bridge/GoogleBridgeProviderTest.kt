package com.kscan.glasses.bridge

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

class GoogleBridgeProviderTest {

    @Test
    fun `capturePhoto throws CaptureException not UnsupportedOperationException`() = runBlocking {
        val bridge = GoogleBridgeProvider()
        try {
            bridge.capturePhoto()
            throw AssertionError("expected CaptureException")
        } catch (e: CaptureException) {
            assertTrue(e.message!!.contains("not implemented"))
        }
    }
}
