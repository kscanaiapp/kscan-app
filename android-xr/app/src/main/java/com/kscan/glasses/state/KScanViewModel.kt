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
import com.kscan.glasses.network.AnalyzeException
import com.kscan.glasses.network.KScanAnalyzeClient
import com.kscan.glasses.network.KScanApiClient
import com.kscan.glasses.network.MockKScanApiClient
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizerFactory
import com.kscan.glasses.privacy.SanitizeResult
import com.kscan.glasses.privacy.SanitizerMode
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
 * @param apiClientOverride Optional injection for tests. If null, resolved via useMockApi flag.
 * @param sanitizerOverride Optional injection for tests. If null, resolved via useMockSanitizer flag.
 */
class KScanViewModel(
    private val bridge: GlassesBridgeProvider,
    useMockApi: Boolean,
    useMockSanitizer: Boolean,
    backendUrl: String,
    apiClientOverride: KScanAnalyzeClient? = null,
    sanitizerOverride: PrivacyImageSanitizer? = null,
) : ViewModel() {

    private val apiClient: KScanAnalyzeClient = apiClientOverride ?: if (useMockApi) {
        MockKScanApiClient()
    } else {
        KScanApiClient(backendUrl)
    }

    private val sanitizer: PrivacyImageSanitizer = sanitizerOverride ?: PrivacyImageSanitizerFactory.create(
        if (useMockSanitizer) SanitizerMode.MOCK else SanitizerMode.PRODUCTION
    )

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

    private var scanSession = ScanSession(id = UUID.randomUUID().toString(), startedAtMs = System.currentTimeMillis())

    private val actionItems = listOf("Scan", "Library", "Settings")
    private val resultsActions = listOf("Save", "Open on Phone", "Scan Again")
    private var focusNavigator = FocusNavigator({ actionItems.size })

    init {
        viewModelScope.launch {
            refreshDeviceState()
        }
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
                "Library" -> _screen.value = AppScreen.LIBRARY
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

            when (val sanitized = sanitizer.sanitize(capture.base64, capture.mimeType)) {
                is SanitizeResult.Blocked, is SanitizeResult.Error -> {
                    showError("Privacy check blocked upload. Please retry.")
                    return
                }
                is SanitizeResult.Success -> {
                    scanSession = scanSession.copy(status = ScanStatus.ANALYZING)
                    val response = apiClient.analyzeImage(sanitized.sanitizedBase64)
                    handleAnalyzeResponse(response)
                }
            }
        } catch (e: CaptureException) {
            showError("Capture failed. Please check camera access and retry.")
        } catch (e: AnalyzeException.Network) {
            showError("Connection issue. Check network and retry.")
        } catch (e: AnalyzeException.Timeout) {
            showError("Analysis timed out. Tap to retry.")
        } catch (e: AnalyzeException.HttpError) {
            showError(e.message ?: "Server error.")
        } catch (e: AnalyzeException.MalformedJson) {
            showError("Server returned an unreadable response.")
        } catch (e: Exception) {
            showError(e.message ?: "Something went wrong.")
        } finally {
            _isProcessing.value = false
        }
    }

    private suspend fun handleAnalyzeResponse(response: AnalyzeResponse) {
        when (response) {
            is NonFashionAnalyzeResult -> {
                val msg = response.message
                speech.speakSummary(msg)
                showError(msg)
            }
            is FashionAnalyzeResult -> {
                val top3 = response.products.take(3)
                val summary = buildString {
                    append(response.result.take(120))
                    if (top3.isNotEmpty()) append(". Top match: ${top3.first().name}.")
                }

                _results.value = ResultsUiState(
                    summary = response.result,
                    topProducts = top3,
                )
                scanSession = scanSession.copy(status = ScanStatus.COMPLETE)

                speech.speakSummary(summary)

                val state = bridge.getDeviceState()
                bridge.sendToPhone(
                    BridgeMessage.AnalysisResult(
                        analysisId = scanSession.id,
                        result = response,
                    ),
                )

                focusNavigator = FocusNavigator({ resultsFocusItemCount() })
                _screen.value = if (_hasDisplay.value) AppScreen.RESULTS else AppScreen.SCAN
            }
        }
    }

    private suspend fun saveFocusedProduct() {
        val product = focusedProduct() ?: return
        val state = bridge.getDeviceState()
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
