package com.kscan.glasses.analyze

import com.kscan.glasses.state.FashionAnalyzeResult
import com.kscan.glasses.state.NonFashionAnalyzeResult
import com.kscan.glasses.state.ProductMatch

/**
 * Analyze response types.
 *
 * Re-exports from state package for analyze boundary consistency.
 */
typealias AnalyzeResponse = com.kscan.glasses.state.AnalyzeResponse
typealias FashionAnalyzeResult = com.kscan.glasses.state.FashionAnalyzeResult
typealias NonFashionAnalyzeResult = com.kscan.glasses.state.NonFashionAnalyzeResult
typealias ProductMatch = com.kscan.glasses.state.ProductMatch
