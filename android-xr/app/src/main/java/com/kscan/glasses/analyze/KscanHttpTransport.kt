package com.kscan.glasses.analyze

import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Real HTTP transport using [HttpURLConnection].
 *
 * No payload logging, no retries, no custom certificate pinning.
 * Minimal surface for controlled backend analyze.
 */
class KscanHttpTransport : HttpTransport {

    override suspend fun post(url: String, body: String, headers: Map<String, String>): HttpTransportResponse {
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                doInput = true
                connectTimeout = 10_000
                readTimeout = 15_000
                instanceFollowRedirects = false
                useCaches = false
                defaultUseCaches = false
                headers.forEach { (key, value) ->
                    setRequestProperty(key, value)
                }
            }

            OutputStreamWriter(connection.outputStream).use { writer ->
                writer.write(body)
                writer.flush()
            }

            val statusCode = connection.responseCode
            val responseBody = if (statusCode in 200..299) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                connection.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
            }

            return HttpTransportResponse(statusCode, responseBody)
        } finally {
            connection?.disconnect()
        }
    }
}
