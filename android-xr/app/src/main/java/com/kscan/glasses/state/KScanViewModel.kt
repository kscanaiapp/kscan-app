package com.kscan.glasses.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kscan.glasses.bridge.BridgeMessage
import com.kscan.glasses.bridge.CaptureException
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.navigation.FocusEvent
import com.kscan.glasses.navigation.FocusNavigator
import com.kscan.glasses.navigation.GlassesInput
import com.kscan.glasses.runtime.GlassesRuntimeState
import com.kscan.glasses.runtime.RuntimeStatus
import com.kscan.glasses.scan.ScanErrorMapper
import com.kscan.glasses.scan.ScanInput
import com.kscan.glasses.scan.ScanOrchestrator
import com.kscan.glasses.scan.ScanOrchestratorResult
import com.kscan.glasses.scan.ScanOrchestratorState
import com.kscan.glasses.voice.SpeechFeedback
import com.kscan.glasses.voice.VoiceAction
import com.kscan.glasses.voice.VoiceCommandController
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * ViewModel for K Scan glasses scan flow.
 *
 * All scan execution is routed through the provided [ScanOrchestrator].
 * The orchestrator is the single authority for capture, sanitization, and analysis.
 */
class KScanViewModel(
    private val bridge: GlassesBridgeProvider,
    private val orchestrator: ScanOrchestrator,
    /**
     * Authoritative runtime status resolved once at composition from the actual
     * injected dependency instances. The UI derives its persistent status header
     * and mock labeling from this — never from loosely related flags.
     * Defaults to MOCK_DEVELOPMENT so tests and previews are always labeled.
     */
    val runtimeStatus: RuntimeStatus = RuntimeStatus(GlassesRuntimeState.MOCK_DEVELOPMENT, mock = true),
) : ViewModel() {

    private val speech = SpeechFeedback(bridge)
    private val voiceParser = VoiceCommandController()

    private val _screen = MutableStateFlow(AppScreen.SCAN)
    val screen: StateFlow<AppScreen> = _screen.asStateFlow()

    private val _results = MutableStateFlow(ResultsUiState())
    val results: StateFlow<ResultsUiState> = _results.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val _isProcessing = MutableStateFlow(false)
    val isProcessing: StateFlow<Boolean> = _isProcessing.asStateFlow()

    private val _hasDisplay = MutableStateFlow(true)
    val hasDisplay: StateFlow<Boolean> = _hasDisplay.asStateFlow()

    private val _lastVoiceAction = MutableStateFlow<VoiceAction?>(null)
    val lastVoiceAction: StateFlow<VoiceAction?> = _lastVoiceAction.asStateFlow()

    private val _deviceConnected = MutableStateFlow(true)
    val deviceConnected: StateFlow<Boolean> = _deviceConnected.asStateFlow()

    private val _orchestratorState = MutableStateFlow(ScanOrchestratorState.READY)
    val orchestratorState: StateFlow<ScanOrchestratorState> = _orchestratorState.asStateFlow()

    private var scanSession = ScanSession(id = UUID.randomUUID().toString(), startedAtMs = System.currentTimeMillis())

    private val actionItems = listOf("Scan", "Closet", "Settings")
    private val resultsActions = listOf("Save", "Open on Phone", "Scan Again")
    private var focusNavigator = FocusNavigator({ actionItems.size })

    init {
        viewModelScope.launch {
            refreshDeviceState()
        }
    }

    /** Entry point for local image picker to route into orchestrator. */
    fun onImagePicked(input: ScanInput) {
        if (_isProcessing.value) return
        viewModelScope.launch { runOrchestratorFlow(input) }
    }

    private suspend fun runOrchestratorFlow(input: ScanInput) {
        _isProcessing.value = true
        _orchestratorState.value = ScanOrchestratorState.PREPARING_IMAGE
        _screen.value = AppScreen.PROCESSING

        _orchestratorState.value = ScanOrchestratorState.PRIVACY_CHECK
        val result = orchestrator.run(input)

        when (result) {
            is ScanOrchestratorResult.Success -> {
                _orchestratorState.value = ScanOrchestratorState.COMPLETE
                val top3 = result.result.products.take(3)
                val summary = buildString {
                    append(result.result.result.take(120))
                    if (top3.isNotEmpty()) append(". Top match: ${top3.first().name}.")
                }
                _results.value = ResultsUiState(
                    summary = result.result.result,
                    topProducts = top3,
                )
                speech.speakSummary(summary)
                bridge.sendToPhone(
                    BridgeMessage.AnalysisResult(
                        analysisId = scanSession.id,
                        result = result.result,
                    ),
                )
                focusNavigator = FocusNavigator({ resultsFocusItemCount() })
                _screen.value = if (_hasDisplay.value) AppScreen.RESULTS else AppScreen.SCAN
            }
            is ScanOrchestratorResult.Failure -> {
                _orchestratorState.value = ScanOrchestratorState.ERROR_RETRY
                val userMessage = ScanErrorMapper.toUserMessage(result.error)
                showError(userMessage)
            }
            is ScanOrchestratorResult.DryRunReady -> {
                _orchestratorState.value = ScanOrchestratorState.COMPLETE
                _results.value = ResultsUiState(
                    summary = "Dry run ready",
                    topProducts = emptyList(),
                )
                speech.speakSummary("Dry run ready")
                _screen.value = if (_hasDisplay.value) AppScreen.RESULTS else AppScreen.SCAN
            }
            is ScanOrchestratorResult.DryRunBlocked -> {
                _orchestratorState.value = ScanOrchestratorState.ERROR_RETRY
                showError("Dry run blocked")
            }
            is ScanOrchestratorResult.ConfigBlocked -> {
                _orchestratorState.value = ScanOrchestratorState.ERROR_RETRY
                showError("Backend config blocked")
            }
        }

        _isProcessing.value = false
    }

    fun onInput(input: GlassesInput) {
        when (input) {
            is GlassesInput.VoiceCommand -> handleVoice(input.transcript)
            is GlassesInput.ScanShortcut -> startScanIfIdle()
            else -> routeFocusInput(input)
        }
    }

    /** Mock voice injection from UI */
    fun simulateVoice(transcript: String) {
        onInput(GlassesInput.VoiceCommand(transcript))
    }

    fun toggleAudioOnlyMode(enabled: Boolean) {
        (bridge as? MockBridgeProvider)?.setAudioOnlyMode(enabled)
        viewModelScope.launch { refreshDeviceState() }
    }

    fun retryFromError() {
        _errorMessage.value = null
        _screen.value = AppScreen.SCAN
    }

    private fun routeFocusInput(input: GlassesInput) {
        when (_screen.value) {
            AppScreen.SCAN -> handleScanScreenInput(input)
            AppScreen.RESULTS -> handleResultsScreenInput(input)
            AppScreen.SETTINGS -> handleSettingsInput(input)
            AppScreen.LIBRARY -> handleLibraryInput(input)
            AppScreen.ERROR -> if (input is GlassesInput.Select) retryFromError()
            AppScreen.PROCESSING -> Unit
        }
    }

    private fun handleScanScreenInput(input: GlassesInput) {
        when (val event = focusNavigator.onInput(input)) {
            is FocusEvent.Activated -> when (actionItems[event.index]) {
                "Scan" -> startScanIfIdle()
                "Closet" -> _screen.value = AppScreen.LIBRARY
                "Settings" -> _screen.value = AppScreen.SETTINGS
            }
            is FocusEvent.Back -> Unit
            is FocusEvent.Scan -> startScanIfIdle()
            else -> Unit
        }
    }

    private fun handleResultsScreenInput(input: GlassesInput) {
        when (input) {
            is GlassesInput.Up, is GlassesInput.Down -> focusNavigator.onInput(input)
            is GlassesInput.Select -> {
                val index = focusNavigator.focusedIndex
                val products = _results.value.topProducts
                viewModelScope.launch {
                    if (index < products.size) {
                        openProductOnPhone(products[index])
                    } else {
                        when (resultsActions.getOrNull(index - products.size)) {
                            "Save" -> saveFocusedProduct()
                            "Open on Phone" -> openFocusedOnPhone()
                            "Scan Again" -> {
                                _screen.value = AppScreen.SCAN
                                focusNavigator = FocusNavigator({ actionItems.size })
                            }
                        }
                    }
                }
            }
            is GlassesInput.Back, is GlassesInput.Left -> {
                _screen.value = AppScreen.SCAN
                focusNavigator = FocusNavigator({ actionItems.size })
            }
            else -> focusNavigator.onInput(input)
        }
    }

    private fun resultsFocusItemCount(): Int =
        _results.value.topProducts.size + resultsActions.size

    private suspend fun openProductOnPhone(product: ProductMatch) {
        product.productUrl?.let { bridge.openOnPhone(it) }
    }

    private fun handleSettingsInput(input: GlassesInput) {
        if (input is GlassesInput.Back || input is GlassesInput.Left) {
            _screen.value = AppScreen.SCAN
        }
    }

    private fun handleLibraryInput(input: GlassesInput) {
        if (input is GlassesInput.Back || input is GlassesInput.Left) {
            _screen.value = AppScreen.SCAN
        }
    }

    private fun handleVoice(transcript: String) {
        val (action, mappedInput) = voiceParser.parse(transcript)
        _lastVoiceAction.value = action
        when (action) {
            VoiceAction.SCAN, VoiceAction.WHAT_AM_I_LOOKING_AT, VoiceAction.FIND_SIMILAR ->
                startScanIfIdle()
            VoiceAction.SAVE -> viewModelScope.launch { saveFocusedProduct() }
            VoiceAction.OPEN_ON_PHONE -> viewModelScope.launch { openFocusedOnPhone() }
            VoiceAction.NEXT -> paginateResults(1)
            VoiceAction.PREVIOUS -> paginateResults(-1)
            VoiceAction.GO_BACK -> {
                _screen.value = AppScreen.SCAN
            }
            VoiceAction.WAKE, VoiceAction.UNKNOWN -> Unit
        }
        mappedInput?.let { if (it !is GlassesInput.ScanShortcut) routeFocusInput(it) }
    }

    private fun startScanIfIdle() {
        if (_isProcessing.value) return
        viewModelScope.launch { runScanFlow() }
    }

    private suspend fun refreshDeviceState() {
        val state = bridge.getDeviceState()
        _hasDisplay.value = state.capabilities.hasDisplay
        _deviceConnected.value = state.connected
    }

    private suspend fun runScanFlow() {
        _isProcessing.value = true
        _screen.value = AppScreen.PROCESSING
        scanSession = scanSession.copy(status = ScanStatus.CAPTURING)

        try {
            bridge.sendToPhone(
                BridgeMessage.AnalysisStarted(
                    analysisId = scanSession.id,
                    captureId = scanSession.id,
                ),
            )

            val capture = bridge.capturePhoto()
            scanSession = scanSession.copy(captureSource = capture.source.name, status = ScanStatus.SANITIZING)

            val input = ScanInput(capture.base64, capture.mimeType)
            runOrchestratorFlow(input)
        } catch (e: CaptureException) {
            showError("Capture failed. Please check camera access and retry.")
        } catch (e: Exception) {
            showError("Something went wrong. Please retry.")
        } finally {
            _isProcessing.value = false
        }
    }

    private suspend fun saveFocusedProduct() {
        val product = focusedProduct() ?: return
        bridge.sendToPhone(
            BridgeMessage.SaveItem(
                itemId = product.id,
                label = product.name,
            ),
        )
        speech.speakSummary("Saved ${product.name}")
    }

    private suspend fun openFocusedOnPhone() {
        val product = focusedProduct() ?: return
        val url = product.productUrl ?: return
        bridge.openOnPhone(url)
        speech.speakSummary("Opening on phone")
    }

    private fun focusedProduct(): ProductMatch? {
        val index = focusNavigator.focusedIndex
        return _results.value.topProducts.getOrNull(index)
            ?: _results.value.topProducts.firstOrNull()
    }

    private fun paginateResults(delta: Int) {
        _results.update { current ->
            val total = current.totalPages
            if (total <= 1) return@update current
            val next = (current.pageIndex + delta).coerceIn(0, total - 1)
            current.copy(pageIndex = next)
        }
    }

    private suspend fun showError(message: String) {
        _errorMessage.value = message
        scanSession = scanSession.copy(status = ScanStatus.ERROR)
        _screen.value = AppScreen.ERROR
        speech.speakSummary(message)
    }

    fun focusedIndex(): Int = focusNavigator.focusedIndex
}
