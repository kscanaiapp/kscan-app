package com.kscan.glasses.analyze

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Real analyze client — compile-safe placeholder.
 *
 * Fails fast if enableRealAnalyze is false.
 * Uses injected HttpTransport; never logs request/response bodies.
 */
class RealAnalyzeClient(
    private val config: AnalyzeClientConfig,
    private val transport: HttpTransport,
) : AnalyzeClient {

    private val jsonParser = Json { ignoreUnknownKeys = true }

    override suspend fun analyze(request: AnalyzeRequest): AnalyzeResponse {
        if (!config.enableRealAnalyze) {
            throw AnalyzeException.Disabled("Real analyze is disabled by config. Use MockAnalyzeClient for tests.")
        }

        val endpoint = config.backendUrl.trimEnd('/') + "/api/analyze"
        val body = StringBuilder().append("{\"image\":\"").append(request.imageDataUrl).append("\"}").toString()

        val response = try {
            transport.post(
                url = endpoint,
                body = body,
                headers = mapOf("Content-Type" to "application/json"),
            )
        } catch (e: java.net.SocketTimeoutException) {
            throw AnalyzeException.Timeout("Analysis timed out after ${config.timeoutMs}ms")
        } catch (e: java.io.IOException) {
            throw AnalyzeException.Network(e.message ?: "Network request failed")
        }

        if (response.statusCode !in 200..299) {
            throw AnalyzeException.HttpError(response.statusCode, "Server error (${response.statusCode})")
        }

        val json = try {
            jsonParser.parseToJsonElement(response.body).jsonObject
        } catch (_: Exception) {
            throw AnalyzeException.MalformedJson("Server returned unreadable JSON")
        }

        return parseAnalyzeResponse(json)
    }

    private fun parseAnalyzeResponse(json: JsonObject): AnalyzeResponse {
        if (json["type"]?.jsonPrimitive?.content == "non-fashion") {
            return NonFashionAnalyzeResult(
                message = json["message"]?.jsonPrimitive?.content ?: "This doesn't appear to be a fashion item.",
            )
        }

        val metadataObj = json["metadata"]?.jsonObject
        val rawProducts = json["products"]?.jsonArray
            ?: json["recommended_products"]?.jsonArray
            ?: json["matches"]?.jsonArray
            ?: json["items"]?.jsonArray
            ?: JsonArray(emptyList())

        val products = rawProducts.mapIndexedNotNull { i, element ->
            val p = element.jsonObject
            ProductMatch(
                id = p["id"]?.jsonPrimitive?.content ?: i.toString(),
                name = p["name"]?.jsonPrimitive?.content ?: p["title"]?.jsonPrimitive?.content ?: "Unknown Product",
                retailer = p["retailer"]?.jsonPrimitive?.content ?: p["brand"]?.jsonPrimitive?.content ?: "Retailer unavailable",
                price = p["price"]?.jsonPrimitive?.content ?: "Price unavailable",
                imageUrl = p["imageUrl"]?.jsonPrimitive?.content ?: p["image_url"]?.jsonPrimitive?.content,
                productUrl = p["productUrl"]?.jsonPrimitive?.content ?: p["product_url"]?.jsonPrimitive?.content ?: p["url"]?.jsonPrimitive?.content,
            )
        }

        return FashionAnalyzeResult(
            result = json["result"]?.jsonPrimitive?.content ?: "",
            category = metadataObj?.get("category")?.jsonPrimitive?.content ?: "",
            color = metadataObj?.get("color")?.jsonPrimitive?.content ?: "",
            silhouette = metadataObj?.get("silhouette")?.jsonPrimitive?.content ?: "",
            products = products,
        )
    }
}
