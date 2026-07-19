package com.kscan.glasses.analyze

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * JSON encoding for analyze request bodies.
 *
 * Uses kotlinx.serialization (already on the classpath) so string escaping
 * (quotes, backslashes, control characters) is always correct by construction.
 * Never log the produced body: it contains the image payload.
 */
object AnalyzeRequestJson {

    /** Client identifier required by the glasses debug backend contract. */
    const val GLASSES_DEBUG_CLIENT_ID = "google-glasses-alpha"

    private val DATA_URL_PREFIX = Regex("^data:image/[a-zA-Z0-9.+-]+;base64,", RegexOption.IGNORE_CASE)

    /**
     * Encodes the glasses debug analyze request body, exactly matching the
     * isolated debug backend contract:
     *
     * ```json
     * {
     *   "image": "data:image/jpeg;base64,...",
     *   "client": "google-glasses-alpha"
     * }
     * ```
     */
    fun encodeGlassesDebugRequest(imageDataUrl: String): String =
        buildJsonObject {
            put("image", imageDataUrl)
            put("client", GLASSES_DEBUG_CLIENT_ID)
        }.toString()

    /**
     * Encodes the upstream K Scan `/api/analyze` body.
     *
     * Contract ([shared/api-contract.md]) requires bare base64 — no data-URI prefix.
     */
    fun encodeUpstreamAnalyzeRequest(imageDataUrlOrBase64: String): String =
        buildJsonObject {
            put("image", toBareBase64(imageDataUrlOrBase64))
        }.toString()

    /** Strips a `data:image/...;base64,` prefix when present; otherwise returns [value] unchanged. */
    fun toBareBase64(value: String): String =
        DATA_URL_PREFIX.replaceFirst(value, "")
}
