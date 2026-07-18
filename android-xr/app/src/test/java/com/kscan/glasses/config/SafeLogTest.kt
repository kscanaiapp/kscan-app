package com.kscan.glasses.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.PrintStream

/**
 * Unit tests for the safe logging wrapper. Structural guarantee (no direct
 * android.util.Log outside this wrapper, no println/printStackTrace anywhere
 * in main sources) is enforced statically by tests/log-safety.test.ts.
 */
class SafeLogTest {

    @Test
    fun `rejects payload and credential markers`() {
        assertTrue(SafeLog.rejectPayloadLog("base64 string here"))
        assertTrue(SafeLog.rejectPayloadLog("data:image/png;base64"))
        assertTrue(SafeLog.rejectPayloadLog("payload bytes"))
        assertTrue(SafeLog.rejectPayloadLog("token value"))
        assertTrue(SafeLog.rejectPayloadLog("client secret"))
        assertTrue(SafeLog.rejectPayloadLog("apikey=xyz"))
        assertTrue(SafeLog.rejectPayloadLog("api_key=xyz"))
        assertTrue(SafeLog.rejectPayloadLog("Bearer abc.def"))
        assertTrue(SafeLog.rejectPayloadLog("Authorization header present"))
        assertTrue(SafeLog.rejectPayloadLog("password=1234"))
    }

    @Test
    fun `rejects urls paths network locations and encoded blobs`() {
        assertTrue(SafeLog.rejectPayloadLog("calling http://example.com"))
        assertTrue(SafeLog.rejectPayloadLog("calling https://example.com/x"))
        assertTrue(SafeLog.rejectPayloadLog("stored at C:\\Users\\dev\\image.jpg"))
        assertTrue(SafeLog.rejectPayloadLog("stored at /Users/dev/image.jpg"))
        assertTrue(SafeLog.rejectPayloadLog("stored at /data/data/com.kscan/files/img.jpg"))
        assertTrue(SafeLog.rejectPayloadLog("backend at 10.0.2.2:8787"))
        assertTrue(SafeLog.rejectPayloadLog("blob: " + "A".repeat(40)))
    }

    @Test
    fun `accepts ordinary structural messages`() {
        assertFalse(SafeLog.rejectPayloadLog("Analysis started"))
        assertFalse(SafeLog.rejectPayloadLog("Capture completed"))
        assertFalse(SafeLog.rejectPayloadLog("Real analyze disabled"))
        assertFalse(SafeLog.rejectPayloadLog("Unexpected scan error"))
        assertFalse(SafeLog.rejectPayloadLog("Dry run blocked"))
        assertFalse(SafeLog.rejectPayloadLog("Server error (500). Please retry."))
    }

    @Test
    fun `describeThrowable reduces to class name only`() {
        val t = IllegalStateException("data:image/jpeg;base64,must-never-appear")
        assertEquals("IllegalStateException", SafeLog.describeThrowable(t))
        // No exception message content survives.
        assertFalse(SafeLog.describeThrowable(t).contains("base64"))
    }

    @Test
    fun `error log never falls back to stderr or stack trace printing`() {
        // In unit tests android.util.Log throws (not mocked), exercising the
        // catch branch. The hardened wrapper must drop the line silently:
        // nothing may reach System.err and no stack trace may be printed.
        val originalErr = System.err
        val captured = ByteArrayOutputStream()
        try {
            System.setErr(PrintStream(captured))
            SafeLog.e("Test", "safe structural message", RuntimeException("raw stack text"))
            SafeLog.e("Test", "safe structural message without throwable")
        } finally {
            System.setErr(originalErr)
        }
        assertEquals("", captured.toString())
    }

    @Test
    fun `rejected messages are dropped before any logging call`() {
        val originalErr = System.err
        val captured = ByteArrayOutputStream()
        try {
            System.setErr(PrintStream(captured))
            // Must return early (rejected) and must not throw or print.
            SafeLog.e("Test", "payload marker present", RuntimeException("x"))
            SafeLog.d("Test", "token marker present")
        } finally {
            System.setErr(originalErr)
        }
        assertEquals("", captured.toString())
    }
}
