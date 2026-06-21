package com.kscan.glasses.network

import com.kscan.glasses.state.AnalyzeResponse
import com.kscan.glasses.state.FashionAnalyzeResult
import com.kscan.glasses.state.NonFashionAnalyzeResult
import com.kscan.glasses.state.ProductMatch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeoutException

interface KScanAnalyzeClient {
    suspend fun analyzeImage(base64: String): AnalyzeResponse
}

class KScanApiClient(
    private val backendUrl: String,
    private val timeoutMs: Int = 10_000,
) : KScanAnalyzeClient {

    override suspend fun analyzeImage(base64: String): AnalyzeResponse = withContext(Dispatchers.IO) {
        val endpoint = "${backendUrl.trimEnd('/')}/api/analyze"
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
            }

            val body = JSONObject().put("image", base64).toString()
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

            val status = connection.responseCode
            val raw = readResponseBody(connection, status)

            val json = try {
                JSONObject(raw)
            } catch (_: Exception) {
                throw AnalyzeException.MalformedJson("Server returned unreadable JSON ($status)")
            }

            if (status !in 200..299) {
                throw AnalyzeException.HttpError(status, "Server error ($status)")
            }

            parseAnalyzeResponse(json)
        } catch (e: AnalyzeException) {
            throw e
        } catch (e: java.net.SocketTimeoutException) {
            throw AnalyzeException.Timeout("Analysis timed out after ${timeoutMs}ms")
        } catch (e: IOException) {
            throw AnalyzeException.Network(e.message ?: "Network request failed")
        } finally {
            connection?.disconnect()
        }
    }

    private fun readResponseBody(connection: HttpURLConnection, status: Int): String {
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        return stream?.bufferedReader()?.use { it.readText() } ?: ""
    }

    private fun parseAnalyzeResponse(json: JSONObject): AnalyzeResponse {
        if (json.optString("type") == "non-fashion") {
            return NonFashionAnalyzeResult(
                message = json.optString("message", "This doesn't appear to be a fashion item."),
            )
        }

        val metadataObj = json.optJSONObject("metadata")
        val rawProducts = json.optJSONArray("products")
            ?: json.optJSONArray("recommended_products")
            ?: json.optJSONArray("matches")
            ?: json.optJSONArray("items")
            ?: JSONArray()

        val products = (0 until rawProducts.length()).mapNotNull { i ->
            val p = rawProducts.optJSONObject(i) ?: return@mapNotNull null
            ProductMatch(
                id = p.optString("id", i.toString()),
                name = p.optString("name", p.optString("title", "Unknown Product")),
                retailer = p.optString("retailer", p.optString("brand", "Retailer unavailable")),
                price = p.optString("price", "Price unavailable"),
                imageUrl = p.optString("imageUrl", p.optString("image_url", null)),
                productUrl = p.optString("productUrl", p.optString("product_url", p.optString("url", null))),
            )
        }

        return FashionAnalyzeResult(
            result = json.optString("result", ""),
            category = metadataObj?.optString("category").orEmpty(),
            color = metadataObj?.optString("color").orEmpty(),
            silhouette = metadataObj?.optString("silhouette").orEmpty(),
            products = products,
        )
    }
}

class MockKScanApiClient : KScanAnalyzeClient {
    override suspend fun analyzeImage(base64: String): AnalyzeResponse {
        return FashionAnalyzeResult(
            result = "Mock: structured wool blazer with relaxed silhouette.",
            category = "outerwear",
            color = "charcoal",
            silhouette = "relaxed",
            products = listOf(
                ProductMatch("1", "Relaxed Wool Blazer", "Mock Retailer", "$298", null, "https://example.com/1"),
                ProductMatch("2", "Charcoal Tailored Jacket", "Mock Retailer", "$245", null, "https://example.com/2"),
                ProductMatch("3", "Oversized Sport Coat", "Mock Retailer", "$189", null, "https://example.com/3"),
                ProductMatch("4", "Should not appear — top 3 only", "Mock", "$0", null, null),
            ),
        )
    }
}

sealed class AnalyzeException(message: String) : Exception(message) {
    class Network(message: String) : AnalyzeException(message)
    class Timeout(message: String) : AnalyzeException(message)
    class HttpError(val status: Int, message: String) : AnalyzeException(message)
    class MalformedJson(message: String) : AnalyzeException(message)
}
