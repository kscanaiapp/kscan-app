package com.kscan.glasses.analyze

import com.kscan.glasses.BuildConfig
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.config.BetaSafetyGuard

/**
 * Controlled backend analyze dry-run gate.
 *
 * Evaluates every real-analyze readiness condition *except* actual transport execution.
 * [DryRunGateResult.Ready] is only returned when all gates are true, including a
 * successful privacy sanitizer run. No [KscanHttpTransport] is constructed.
 */
object AnalyzeDryRunGate {

    fun evaluate(
        betaConfig: BetaConfig,
        clientConfig: AnalyzeClientConfig,
        debugConfig: DebugAnalyzeConfig,
        sanitizerSuccess: Boolean,
        isDebugBuild: Boolean = BuildConfig.DEBUG,
    ): DryRunGateResult {
        if (!isDebugBuild) {
            return DryRunGateResult.ConfigBlocked("release_build")
        }
        if (betaConfig.useMockApi) {
            return DryRunGateResult.ConfigBlocked("useMockApi")
        }
        if (!betaConfig.enableRealAnalyze) {
            return DryRunGateResult.ConfigBlocked("enableRealAnalyze")
        }
        if (!betaConfig.enableRealFaceMasking) {
            return DryRunGateResult.ConfigBlocked("enableRealFaceMasking")
        }
        if (!betaConfig.enableDryRun) {
            return DryRunGateResult.ConfigBlocked("enableDryRun")
        }
        if (clientConfig.backendUrl.isBlank()) {
            return DryRunGateResult.ConfigBlocked("backend_url_missing")
        }
        if (!debugConfig.isPresent) {
            return DryRunGateResult.ConfigBlocked("debug_backend_config_missing")
        }
        if (!BetaSafetyGuard.permitsRealAnalyzePreparation(betaConfig, isDebugBuild)) {
            return DryRunGateResult.ConfigBlocked("safety_guard")
        }
        if (!sanitizerSuccess) {
            return DryRunGateResult.Blocked("sanitizer_failed")
        }
        return DryRunGateResult.Ready
    }
}
