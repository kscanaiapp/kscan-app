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
        Log.d("$TAG_PREFIX.$tag", message)
    }

    @JvmStatic
    fun i(tag: String, message: String) {
        Log.i("$TAG_PREFIX.$tag", message)
    }

    @JvmStatic
    fun w(tag: String, message: String) {
        Log.w("$TAG_PREFIX.$tag", message)
    }

    @JvmStatic
    fun e(tag: String, message: String, throwable: Throwable? = null) {
        if (throwable != null) {
            Log.e("$TAG_PREFIX.$tag", message, throwable)
        } else {
            Log.e("$TAG_PREFIX.$tag", message)
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
