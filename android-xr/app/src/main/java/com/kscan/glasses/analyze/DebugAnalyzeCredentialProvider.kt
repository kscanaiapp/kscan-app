package com.kscan.glasses.analyze

import android.content.Context
import java.io.File

/**
 * Runtime-only credential provider for the local debug analyze endpoint.
 *
 * SECURITY:
 * - Never reads tokens from BuildConfig or APK resources.
 * - Never logs the token value.
 * - Debug builds only: release callers must leave [DebugAnalyzeConfig.authToken] blank.
 *
 * Operator supply (emulator / local device):
 * ```
 * adb shell "echo -n 'YOUR_TOKEN' > /data/local/tmp/kscan_glasses_debug_token"
 * # optional app-private copy after install:
 * adb shell "run-as com.kscan.glasses sh -c 'cat /data/local/tmp/kscan_glasses_debug_token > files/kscan_debug_auth_token'"
 * ```
 */
object DebugAnalyzeCredentialProvider {

    /** App-private file under [Context.getFilesDir]. */
    const val APP_TOKEN_FILE_NAME = "kscan_debug_auth_token"

    /** Emulator/host-pushed world-readable temp file (debug smoke only). */
    const val TMP_TOKEN_PATH = "/data/local/tmp/kscan_glasses_debug_token"

    /**
     * Reads a trimmed non-empty auth token from the first available source, or "".
     * Does not throw on missing/unreadable files.
     */
    fun read(context: Context?): String {
        val fromApp = context?.let { readFile(File(it.filesDir, APP_TOKEN_FILE_NAME)) }.orEmpty()
        if (fromApp.isNotEmpty()) return fromApp

        val fromTmp = readFile(File(TMP_TOKEN_PATH))
        if (fromTmp.isNotEmpty()) return fromTmp

        return ""
    }

    /**
     * Merges a runtime token into BuildConfig-derived debug config.
     * Blank [runtimeToken] leaves [DebugAnalyzeConfig.authToken] empty (safe default).
     */
    fun mergeInto(config: DebugAnalyzeConfig, runtimeToken: String): DebugAnalyzeConfig {
        val trimmed = runtimeToken.trim()
        return if (trimmed.isEmpty()) config else config.copy(authToken = trimmed)
    }

    private fun readFile(file: File): String {
        return try {
            if (!file.isFile || !file.canRead()) return ""
            file.readText(Charsets.UTF_8).trim()
        } catch (_: Exception) {
            ""
        }
    }
}
