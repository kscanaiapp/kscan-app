package com.kscan.glasses.analyze

/**
 * Minimal HTTP transport interface for analyze client boundary.
 *
 * No real implementation in this file — compile-safe placeholder only.
 */
interface HttpTransport {
    suspend fun post(url: String, body: String, headers: Map<String, String> = emptyMap()): HttpTransportResponse
}

data class HttpTransportResponse(
    val statusCode: Int,
    val body: String,
)

/**
 * Fake HTTP transport for unit tests. Never makes real network calls.
 */
class FakeHttpTransport(
    private val handler: (String, String, Map<String, String>) -> HttpTransportResponse
) : HttpTransport {
    val calls = mutableListOf<Triple<String, String, Map<String, String>>>()

    override suspend fun post(url: String, body: String, headers: Map<String, String>): HttpTransportResponse {
        calls.add(Triple(url, body, headers))
        return handler(url, body, headers)
    }
}
