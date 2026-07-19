package com.kscan.glasses.config

import android.util.Log

/**
 * Safe logging wrapper. This is the ONLY place in app main sources that may
 * touch android.util.Log; a static contract test (tests/log-safety.test.ts)
 * enforces it.
 *
 * Allowed: structural logs, errors, lifecycle events.
 * Forbidden: payloads, image bytes, base64, EXIF, tokens, secrets, URLs with tokens, raw responses.
 *
 * Hard rules:
 * - No console (stdout/stderr) or stack-trace fallback. Those channels
 *   bypass the payload filter and print raw stack traces that can carry
 *   payload-derived text. When platform logging is unavailable (unit tests),
 *   the log line is dropped silently.
 * - Never pass a raw Throwable to a Log overload: its stack trace and message
 *   can embed payload text. Only the throwable's class name may be logged
 *   (see [describeThrowable]).
 */
object SafeLog {

    private const val TAG_PREFIX = "KScan"

    /** IPv4 literal (e.g. emulator host routes like 10.0.2.2). */
    private val IPV4_REGEX = Regex("\\b\\d{1,3}(\\.\\d{1,3}){3}\\b")

    /** Long base64-like runs (encoded blobs never belong in log lines). */
    private val LONG_BASE64_RUN = Regex("[A-Za-z0-9+/]{32,}={0,2}")

    @JvmStatic
    fun d(tag: String, message: String) {
        if (rejectPayloadLog(message)) return
        try {
            Log.d("$TAG_PREFIX.$tag", message)
        } catch (_: RuntimeException) {
            // No fallback: dropped silently when Log is not mocked (unit tests).
        }
    }

    @JvmStatic
    fun i(tag: String, message: String) {
        if (rejectPayloadLog(message)) return
        try {
            Log.i("$TAG_PREFIX.$tag", message)
        } catch (_: RuntimeException) {
            // No fallback: dropped silently when Log is not mocked (unit tests).
        }
    }

    @JvmStatic
    fun w(tag: String, message: String) {
        if (rejectPayloadLog(message)) return
        try {
            Log.w("$TAG_PREFIX.$tag", message)
        } catch (_: RuntimeException) {
            // No fallback: dropped silently when Log is not mocked (unit tests).
        }
    }

    @JvmStatic
    fun e(tag: String, message: String, throwable: Throwable? = null) {
        if (rejectPayloadLog(message)) return
        // Throwable is reduced to its class name only; the raw stack trace and
        // exception message are never logged (both can carry payload text).
        val safeMessage = if (throwable != null) {
            "$message [${describeThrowable(throwable)}]"
        } else {
            message
        }
        try {
            Log.e("$TAG_PREFIX.$tag", safeMessage)
        } catch (_: RuntimeException) {
            // No fallback: console printing would bypass the payload filter
            // and could emit raw stack traces. Dropped silently (unit tests).
        }
    }

    /**
     * Reduces a throwable to its class name only. Stack traces and exception
     * messages are never logged: both can carry payload-derived text.
     */
    @JvmStatic
    fun describeThrowable(throwable: Throwable): String =
        throwable.javaClass.simpleName.ifBlank { "Throwable" }

    /**
     * Reject any message that looks like it contains payload data, credentials,
     * URLs, filesystem paths, network locations, or encoded blobs.
     */
    @JvmStatic
    fun rejectPayloadLog(message: String): Boolean {
        val lower = message.lowercase()
        return lower.contains("base64") ||
            lower.contains("data:image") ||
            lower.contains("payload") ||
            lower.contains("token") ||
            lower.contains("secret") ||
            lower.contains("apikey") ||
            lower.contains("api_key") ||
            lower.contains("bearer") ||
            lower.contains("authorization") ||
            lower.contains("password") ||
            lower.contains("http://") ||
            lower.contains("https://") ||
            lower.contains("c:\\") ||
            lower.contains("/users/") ||
            lower.contains("/data/") ||
            IPV4_REGEX.containsMatchIn(message) ||
            LONG_BASE64_RUN.containsMatchIn(message)
    }
}
