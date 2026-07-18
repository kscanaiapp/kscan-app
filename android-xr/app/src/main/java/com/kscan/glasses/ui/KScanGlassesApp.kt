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
import com.kscan.glasses.state.AppScreen
import com.kscan.glasses.state.KScanViewModel
import com.kscan.glasses.ui.components.RuntimeStatusHeader
import com.kscan.glasses.ui.components.RuntimeStatusLabels
import com.kscan.glasses.ui.screens.ErrorScreen
import com.kscan.glasses.ui.screens.LibraryScreen
import com.kscan.glasses.ui.screens.ProcessingScreen
import com.kscan.glasses.ui.screens.ResultsScreen
import com.kscan.glasses.ui.screens.ScanScreen
import com.kscan.glasses.ui.screens.SettingsScreen

private val Obsidian = Color(0xFF0A0A0F)

@Composable
fun KScanGlassesApp(viewModel: KScanViewModel) {
    val screen by viewModel.screen.collectAsState()
    val results by viewModel.results.collectAsState()
    val error by viewModel.errorMessage.collectAsState()
    val isProcessing by viewModel.isProcessing.collectAsState()
    val hasDisplay by viewModel.hasDisplay.collectAsState()
    val lastVoice by viewModel.lastVoiceAction.collectAsState()
    val runtimeStatus = viewModel.runtimeStatus

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Obsidian),
    ) {
        // Persistent honesty header on every screen: ALPHA, MOCK (when any mock
        // component is active), pipeline state, and HW VALIDATION PENDING.
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
                    onToggleAudioOnly = { viewModel.toggleAudioOnlyMode(it) },
                    onSimulateVoice = viewModel::simulateVoice,
                )
                AppScreen.ERROR -> ErrorScreen(
                    message = error ?: "Unknown error",
                    onRetry = viewModel::retryFromError,
                )
            }
        }
    }
}
