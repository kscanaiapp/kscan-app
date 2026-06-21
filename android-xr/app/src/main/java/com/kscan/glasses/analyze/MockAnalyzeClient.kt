package com.kscan.glasses.analyze

/**
 * Mock analyze client for tests and local development.
 *
 * No network calls. No payload logging. Returns deterministic mock data.
 */
class MockAnalyzeClient : AnalyzeClient {

    override suspend fun analyze(request: AnalyzeRequest): AnalyzeResponse {
        return FashionAnalyzeResult(
            result = "Mock: structured wool blazer with relaxed silhouette.",
            category = "outerwear",
            color = "charcoal",
            silhouette = "relaxed",
            products = listOf(
                ProductMatch("1", "Relaxed Wool Blazer", "Mock Retailer", "$298", null, "https://example.com/1"),
                ProductMatch("2", "Charcoal Tailored Jacket", "Mock Retailer", "$245", null, "https://example.com/2"),
                ProductMatch("3", "Oversized Sport Coat", "Mock Retailer", "$189", null, "https://example.com/3"),
            ),
        )
    }
}
