package com.kscan.glasses.config

import android.util.Log

/**
 * Safe logging wrapper.
 *
 * Allowed: structural logs, errors, lifecycle events.
 * Forbidden: payloads, image bytes, base64, EXIF, tokens, secrets, URLs with tokens, raw responses.
 */
object SafeLog {

    private const val TAG_PREFIX = "KScan"

    @JvmStatic
    fun d(tag: String, message: String) {
        try {
            Log.d("$TAG_PREFIX.$tag", message)
        } catch (_: RuntimeException) {
            // Fallback for unit tests where Android Log is not mocked
        }
    }

    @JvmStatic
    fun i(tag: String, message: String) {
        try {
            Log.i("$TAG_PREFIX.$tag", message)
        } catch (_: RuntimeException) {
            // Fallback for unit tests where Android Log is not mocked
        }
    }

    @JvmStatic
    fun w(tag: String, message: String) {
        try {
            Log.w("$TAG_PREFIX.$tag", message)
        } catch (_: RuntimeException) {
            // Fallback for unit tests where Android Log is not mocked
        }
    }

    @JvmStatic
    fun e(tag: String, message: String, throwable: Throwable? = null) {
        try {
            if (throwable != null) {
                Log.e("$TAG_PREFIX.$tag", message, throwable)
            } else {
                Log.e("$TAG_PREFIX.$tag", message)
            }
        } catch (_: RuntimeException) {
            // Fallback for unit tests where Android Log is not mocked
            System.err.println("[$TAG_PREFIX.$tag] ERROR: $message")
            throwable?.printStackTrace()
        }
    }

    /** Reject any message that looks like it contains a payload. */
    @JvmStatic
    fun rejectPayloadLog(message: String): Boolean {
        val lower = message.lowercase()
        return lower.contains("base64") ||
            lower.contains("data:image") ||
            lower.contains("payload") ||
            lower.contains("token") ||
            lower.contains("secret") ||
            lower.contains("apikey")
    }
}
