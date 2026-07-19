package com.kscan.glasses.analyze

import com.kscan.glasses.state.FashionAnalyzeResult
import com.kscan.glasses.state.NonFashionAnalyzeResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Narrow client for the glasses debug endpoint (`/api/glasses/analyze-debug`).
 *
 * This is a debug-only boundary. It is NOT intended for production or the main
 * K Scan backend (`/api/analyze`). It maps the debug endpoint's HUD-safe JSON
 * contract into the existing [AnalyzeResponse] model so that UI and downstream
 * code require no changes.
 *
 * No payload logging. No image persistence. Auth token is injected, never logged.
 */
class GlassesDebugEndpointClient(
    private val endpointUrl: String,
    private val authToken: String,
    private val transport: HttpTransport,
) : AnalyzeClient {

    private val jsonParser = Json { ignoreUnknownKeys = true }

    override suspend fun analyze(request: AnalyzeRequest): AnalyzeResponse {
        val body = buildRequestBody(request)

        val response = try {
            transport.post(
                url = endpointUrl,
                body = body,
                headers = mapOf(
                    "Content-Type" to "application/json",
                    "Authorization" to "Bearer $authToken",
                ),
            )
        } catch (e: java.net.SocketTimeoutException) {
            throw AnalyzeException.Timeout("Debug endpoint timed out")
        } catch (e: java.io.IOException) {
            throw AnalyzeException.Network(e.message ?: "Debug endpoint network error")
        }

        return parseResponse(response)
    }

    private fun buildRequestBody(request: AnalyzeRequest): String {
        // Exact debug backend contract: {"image": "...", "client": "google-glasses-alpha"}.
        // kotlinx.serialization handles all string escaping; never log this body.
        return AnalyzeRequestJson.encodeGlassesDebugRequest(request.imageDataUrl)
    }

    private fun parseResponse(response: HttpTransportResponse): AnalyzeResponse {
        val json = try {
            jsonParser.parseToJsonElement(response.body).jsonObject
        } catch (_: Exception) {
            throw AnalyzeException.MalformedJson("Debug endpoint returned unreadable JSON")
        }

        val ok = json["ok"]?.jsonPrimitive?.content?.toBoolean() ?: false
        if (!ok) {
            val error = json["error"]?.jsonObject
            val code = error?.get("code")?.jsonPrimitive?.content ?: "SAFE_BACKEND_FAILURE"
            val message = error?.get("message")?.jsonPrimitive?.content ?: "The image could not be analyzed."
            throw AnalyzeException.HttpError(response.statusCode, "$code: $message")
        }

        val result = json["result"]?.jsonObject
            ?: throw AnalyzeException.MalformedJson("Missing result field in debug response")

        val title = result["title"]?.jsonPrimitive?.content ?: "Analysis"
        val summary = result["summary"]?.jsonPrimitive?.content ?: ""
        val attributes = result["attributes"]?.jsonArray ?: JsonArray(emptyList())

        val category = extractAttribute(attributes, "category")
        val color = extractAttribute(attributes, "color")
        val silhouette = extractAttribute(attributes, "silhouette")

        return FashionAnalyzeResult(
            result = buildString {
                append(title)
                if (summary.isNotBlank()) {
                    append(" — ")
                    append(summary)
                }
            },
            category = category,
            color = color,
            silhouette = silhouette,
            products = emptyList(),
        )
    }

    private fun extractAttribute(attributes: JsonArray, name: String): String {
        return attributes.firstOrNull { attr ->
            (attr as? JsonObject)?.get("name")?.jsonPrimitive?.content == name
        }?.let { (it as JsonObject)["value"]?.jsonPrimitive?.content } ?: ""
    }
}
