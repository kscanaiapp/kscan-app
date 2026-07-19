package com.kscan.glasses.scan

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeClientConfig
import com.kscan.glasses.analyze.DebugAnalyzeConfig
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.phonebridge.PhoneBridgeProvider
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/**
 * Factory for creating a ScanOrchestrator.
 *
 * [sanitizer], [analyzeClient], and [phoneBridge] are REQUIRED parameters with no
 * defaults: no production path may silently resolve to a mock. Callers must obtain
 * them from the single authoritative composition point (AppRuntimeFactory).
 */
object ScanOrchestratorFactory {

    fun create(
        sanitizer: PrivacyImageSanitizer,
        analyzeClient: AnalyzeClient,
        phoneBridge: PhoneBridgeProvider,
        config: BetaConfig = BetaConfig.DEFAULT,
        clientConfig: AnalyzeClientConfig = AnalyzeClientConfig.MOCK_ONLY,
        debugConfig: DebugAnalyzeConfig = DebugAnalyzeConfig.DEFAULT,
        ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    ): ScanOrchestrator {
        return ScanOrchestrator(
            sanitizer = sanitizer,
            analyzeClient = analyzeClient,
            phoneBridge = phoneBridge,
            config = config,
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            ioDispatcher = ioDispatcher,
        )
    }
}
