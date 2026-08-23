package com.kscan.glasses.phonebridge

import java.io.BufferedInputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class PairingTicket(
    val pairingHandle: String,
    val challengeCode: String,
    val pairingSecret: String,
    val expiresAt: Long,
)

@Serializable
data class BridgePoll(
    val frames: List<String> = emptyList(),
    val cursor: Long = 0,
    val wearableToken: String? = null,
)

/** Backend seam used by the real provider. Tokens are sent only in headers/body over HTTPS. */
interface WearableBridgeApi {
    suspend fun createPairing(frame: String): PairingTicket
    suspend fun pollPairing(pairingHandle: String, pairingSecret: String, after: Long): BridgePoll
    suspend fun send(wearableToken: String, frame: String)
    suspend fun poll(wearableToken: String, after: Long): BridgePoll
}

/** Small, bounded HTTPS client for the Supabase wearable-bridge Edge Function. */
class HttpWearableBridgeApi(
    endpoint: String,
    private val publishableKey: String,
    private val connectTimeoutMs: Int = 5_000,
    private val readTimeoutMs: Int = 15_000,
) : WearableBridgeApi {
    private val endpointUrl = endpoint.trim()
    private val json = Json { ignoreUnknownKeys = false; encodeDefaults = true }

    init {
        require(endpointUrl.startsWith("https://")) { "wearable bridge must use HTTPS" }
        require(publishableKey.isNotBlank()) { "publishable key is required" }
    }

    override suspend fun createPairing(frame: String): PairingTicket =
        post(Request("pair.create", frame = frame)).ticket
            ?: throw WearableBridgeException("PAIR_CREATE_FAILED")

    override suspend fun pollPairing(pairingHandle: String, pairingSecret: String, after: Long): BridgePoll =
        post(Request("pair.poll", pairingHandle = pairingHandle, pairingSecret = pairingSecret, after = after)).poll
            ?: BridgePoll(cursor = after)

    override suspend fun send(wearableToken: String, frame: String) {
        post(Request("session.send", wearableToken = wearableToken, frame = frame))
    }

    override suspend fun poll(wearableToken: String, after: Long): BridgePoll =
        post(Request("session.poll", wearableToken = wearableToken, after = after)).poll
            ?: BridgePoll(cursor = after)

    private suspend fun post(request: Request): Response = withContext(Dispatchers.IO) {
        val requestBytes = json.encodeToString(request).toByteArray(Charsets.UTF_8)
        require(requestBytes.size <= PhoneBridgeProtocol.MAX_MESSAGE_BYTES + REQUEST_OVERHEAD_BYTES) {
            "bridge request too large"
        }
        val connection = (URL(endpointUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            doOutput = true
            instanceFollowRedirects = false
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("apikey", publishableKey)
        }
        try {
            connection.outputStream.use { it.write(requestBytes) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val bytes = BufferedInputStream(stream ?: throw WearableBridgeException("EMPTY_RESPONSE")).use {
                readBounded(it, MAX_RESPONSE_BYTES)
            }
            if (code !in 200..299) throw WearableBridgeException("HTTP_$code")
            json.decodeFromString(Response.serializer(), bytes.toString(Charsets.UTF_8))
        } catch (error: WearableBridgeException) {
            throw error
        } catch (_: Exception) {
            throw WearableBridgeException("NETWORK_FAILURE")
        } finally {
            connection.disconnect()
        }
    }

    private fun readBounded(stream: java.io.InputStream, ceiling: Int): ByteArray {
        val output = java.io.ByteArrayOutputStream(minOf(8_192, ceiling))
        val buffer = ByteArray(8_192)
        var total = 0
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            total += count
            if (total > ceiling) throw WearableBridgeException("RESPONSE_TOO_LARGE")
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    @Serializable
    private data class Request(
        val operation: String,
        val pairingHandle: String? = null,
        val pairingSecret: String? = null,
        val wearableToken: String? = null,
        val frame: String? = null,
        val after: Long = 0,
    )

    @Serializable
    private data class Response(
        val ticket: PairingTicket? = null,
        val poll: BridgePoll? = null,
        val ok: Boolean = true,
    )

    companion object {
        private const val REQUEST_OVERHEAD_BYTES = 4_096
        private const val MAX_RESPONSE_BYTES = PhoneBridgeProtocol.MAX_MESSAGE_BYTES * 4
    }

}

class WearableBridgeException(val safeCode: String) : Exception(safeCode)
