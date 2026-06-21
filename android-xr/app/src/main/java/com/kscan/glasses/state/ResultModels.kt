package com.kscan.glasses.state

data class ProductMatch(
    val id: String,
    val name: String,
    val retailer: String,
    val price: String,
    val imageUrl: String? = null,
    val productUrl: String? = null,
)

sealed class AnalyzeResponse

data class FashionAnalyzeResult(
    val result: String,
    val category: String,
    val color: String,
    val silhouette: String,
    val products: List<ProductMatch>,
) : AnalyzeResponse()

data class NonFashionAnalyzeResult(
    val message: String,
) : AnalyzeResponse()

enum class AppScreen {
    SCAN,
    PROCESSING,
    RESULTS,
    LIBRARY,
    SETTINGS,
    ERROR,
}

data class ResultsUiState(
    val summary: String = "",
    val topProducts: List<ProductMatch> = emptyList(),
    val pageIndex: Int = 0,
    val pageSize: Int = 3,
) {
    val pagedProducts: List<ProductMatch>
        get() {
            val start = pageIndex * pageSize
            return topProducts.drop(start).take(pageSize)
        }

    val totalPages: Int
        get() = if (topProducts.isEmpty()) 0 else ((topProducts.size - 1) / pageSize) + 1
}
