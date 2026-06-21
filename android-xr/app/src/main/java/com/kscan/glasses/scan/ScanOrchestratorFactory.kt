package com.kscan.glasses.scan

import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.config.SafeLog
import com.kscan.glasses.mobilebridge.MobileAppBridge
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.state.FashionAnalyzeResult
import com.kscan.glasses.state.ProductMatch
import com.kscan.glasses.state.ResultsUiState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/**
 * Factory for creating a ScanOrchestrator with safe defaults for Phase 2.
 */
object ScanOrchestratorFactory {

    fun create(
        config: BetaConfig = BetaConfig.DEFAULT,
        sanitizer: PrivacyImageSanitizer = MockPrivacyImageSanitizer(),
        analyzeClient: com.kscan.glasses.analyze.AnalyzeClient = com.kscan.glasses.analyze.MockAnalyzeClient(),
        mobileBridge: MobileAppBridge = com.kscan.glasses.mobilebridge.MockMobileAppBridge(),
        ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    ): ScanOrchestrator {
        return ScanOrchestrator(
            sanitizer = sanitizer,
            analyzeClient = analyzeClient,
            mobileBridge = mobileBridge,
            config = config,
            ioDispatcher = ioDispatcher,
        )
    }
}
