package com.kscan.glasses.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import android.os.Build
import com.kscan.glasses.BuildConfig
import com.kscan.glasses.phonebridge.PhoneBridgeProviderStatus
import com.kscan.glasses.state.AppScreen
import com.kscan.glasses.state.KScanViewModel
import com.kscan.glasses.ui.components.RuntimeStatusHeader
import com.kscan.glasses.ui.components.RuntimeStatusLabels
import com.kscan.glasses.ui.screens.ConnectedHudScreen
import com.kscan.glasses.ui.screens.ErrorScreen
import com.kscan.glasses.ui.screens.LibraryScreen
import com.kscan.glasses.ui.screens.ProcessingScreen
import com.kscan.glasses.ui.screens.ResultsScreen
import com.kscan.glasses.ui.screens.ScanScreen
import com.kscan.glasses.ui.screens.SettingsScreen

@Composable
fun KScanGlassesApp(viewModel: KScanViewModel) {
    val screen by viewModel.screen.collectAsState()
    val results by viewModel.results.collectAsState()
    val error by viewModel.errorMessage.collectAsState()
    val isProcessing by viewModel.isProcessing.collectAsState()
    val hasDisplay by viewModel.hasDisplay.collectAsState()
    val lastVoice by viewModel.lastVoiceAction.collectAsState()
    val runtimeStatus = viewModel.runtimeStatus
    val bridgeDiagnostics by viewModel.phoneBridgeDiagnostics.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        Box(modifier = Modifier.padding(start = 20.dp, top = 12.dp)) {
            RuntimeStatusHeader(status = runtimeStatus)
        }
        Box(modifier = Modifier.fillMaxSize()) {
            when (screen) {
                AppScreen.SCAN -> ScanScreen(
                    focusedIndex = viewModel.focusedIndex(),
                    isProcessing = isProcessing,
                    lastVoiceAction = lastVoice?.name,
                    onSimulateVoice = viewModel::simulateVoice,
                )
                AppScreen.PROCESSING -> ProcessingScreen()
                AppScreen.RESULTS -> ResultsScreen(
                    summary = results.summary,
                    products = results.pagedProducts,
                    focusedIndex = viewModel.focusedIndex(),
                    pageLabel = if (results.totalPages > 1) {
                        "Page ${results.pageIndex + 1} of ${results.totalPages}"
                    } else {
                        null
                    },
                    mockBadge = RuntimeStatusLabels.resultsMockBadge(runtimeStatus),
                )
                AppScreen.LIBRARY -> LibraryScreen()
                AppScreen.SETTINGS -> SettingsScreen(
                    hasDisplay = hasDisplay,
                    focusedIndex = viewModel.focusedIndex(),
                    voiceSamples = viewModel.settingsVoiceSamples,
                    onToggleAudioOnly = { viewModel.toggleAudioOnlyMode(it) },
                    onSimulateVoice = viewModel::simulateVoice,
                    diagnostics = if (viewModel.connectedMode) {
                        listOf(
                            "App" to BuildConfig.VERSION_NAME,
                            "Source" to BuildConfig.KSCAN_BUILD_SHA.take(12),
                            "Build" to BuildConfig.BUILD_TYPE.uppercase(),
                            "Android" to "API ${Build.VERSION.SDK_INT}",
                            "XR state" to if (BuildConfig.HARDWARE_CANDIDATE) "CANDIDATE / HW PENDING" else "DEV / EMULATOR",
                        ) + bridgeDiagnostics
                    } else emptyList(),
                )
                AppScreen.ERROR -> ErrorScreen(
                    message = error ?: "Unknown error",
                    onRetry = viewModel::retryFromError,
                )
                AppScreen.CONNECTED -> ConnectedHudDestination(viewModel, runtimeStatus)
            }
        }
    }
}

@Composable
private fun ConnectedHudDestination(
    viewModel: KScanViewModel,
    runtimeStatus: com.kscan.glasses.runtime.RuntimeStatus,
) {
    val ui by viewModel.connected.collectAsState()
    val status by viewModel.phoneBridgeStatus.collectAsState()
    val items by viewModel.connectedItems.collectAsState()
    val notice by viewModel.actionNotice.collectAsState()
    val pairingCode by viewModel.pairingCode.collectAsState()
    val current = ui ?: return
    ConnectedHudScreen(
        ui = current,
        providerStatus = status ?: PhoneBridgeProviderStatus.UNAVAILABLE,
        focusItems = items,
        focusedIndex = viewModel.focusedIndex(),
        actionNotice = notice,
        pairingCode = pairingCode,
        mockBadge = RuntimeStatusLabels.resultsMockBadge(runtimeStatus),
    )
}
