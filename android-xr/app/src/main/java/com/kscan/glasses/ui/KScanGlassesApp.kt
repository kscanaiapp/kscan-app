package com.kscan.glasses.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.kscan.glasses.state.AppScreen
import com.kscan.glasses.state.KScanViewModel
import com.kscan.glasses.ui.screens.ErrorScreen
import com.kscan.glasses.ui.screens.LibraryScreen
import com.kscan.glasses.ui.screens.ProcessingScreen
import com.kscan.glasses.ui.screens.ResultsScreen
import com.kscan.glasses.ui.screens.ScanScreen
import com.kscan.glasses.ui.screens.SettingsScreen

private val Obsidian = Color(0xFF0A0A0F)
private val CyanAccent = Color(0xFF00E5FF)

@Composable
fun KScanGlassesApp(viewModel: KScanViewModel) {
    val screen by viewModel.screen.collectAsState()
    val results by viewModel.results.collectAsState()
    val error by viewModel.errorMessage.collectAsState()
    val isProcessing by viewModel.isProcessing.collectAsState()
    val hasDisplay by viewModel.hasDisplay.collectAsState()
    val lastVoice by viewModel.lastVoiceAction.collectAsState()

    androidx.compose.foundation.layout.Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Obsidian),
    ) {
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
