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
import com.kscan.glasses.phonebridge.PhoneBridgeEvent
import com.kscan.glasses.phonebridge.PhoneBridgeProvider
import com.kscan.glasses.phonebridge.PhoneBridgeProviderStatus
import com.kscan.glasses.phonebridge.PhoneBridgeSendResult
import com.kscan.glasses.runtime.ConnectedAction
import com.kscan.glasses.runtime.ConnectedEffect
import com.kscan.glasses.runtime.ConnectedInput
import com.kscan.glasses.runtime.ConnectedRuntimeStateMachine
import com.kscan.glasses.runtime.ConnectedState
import com.kscan.glasses.runtime.ConnectedUiState
import com.kscan.glasses.runtime.GlassesRuntimeState
import com.kscan.glasses.runtime.RuntimeStatus
import com.kscan.glasses.scan.ScanErrorCode
import com.kscan.glasses.scan.ScanErrorMapper
import com.kscan.glasses.scan.ScanInput
import com.kscan.glasses.scan.ScanOrchestrator
import com.kscan.glasses.scan.ScanOrchestratorResult
import com.kscan.glasses.scan.ScanOrchestratorState
import com.kscan.glasses.voice.SpeechFeedback
import com.kscan.glasses.voice.VoiceAction
import com.kscan.glasses.voice.VoiceCommandController
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
 *
 * Connected mode: when a [PhoneBridgeProvider] is injected, the app root becomes
 * [AppScreen.CONNECTED] and the HUD is driven by a [ConnectedRuntimeStateMachine]
 * fed from [PhoneBridgeProvider.events]. Legacy mode (null provider) is
 * byte-identical to the pre-connected behavior: every existing screen and flow
 * is untouched.
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
    /**
     * Connected-runtime phone bridge; null selects the legacy mock scan flow.
     * Injected by MainActivity from the verified app runtime.
     */
    private val phoneBridge: PhoneBridgeProvider? = null,
    /**
     * Bounded wait for the companion's action ack (result.update) before the HUD
     * surfaces ACTION_TIMEOUT. Injectable for tests; never optimistic — the
     * confirmation card is shown only after the ack arrives.
     */
    private val ackTimeoutMs: Long = DEFAULT_ACK_TIMEOUT_MS,
) : ViewModel() {

    private val speech = SpeechFeedback(bridge)
    private val voiceParser = VoiceCommandController()

    private val _screen = MutableStateFlow(AppScreen.SCAN)
    val screen: StateFlow<AppScreen> = _screen.asStateFlow()

    private val _results = MutableStateFlow(ResultsUiState())
    val results: StateFlow<ResultsUiState> = _results.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    /**
     * Stable machine-readable code paired with [errorMessage]. Null when no
     * error is active. Never payload-derived.
     */
    private val _errorCode = MutableStateFlow<ScanErrorCode?>(null)
    val errorCode: StateFlow<ScanErrorCode?> = _errorCode.asStateFlow()

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

    /** Mock voice sample phrases shown in Settings; D-pad selectable. */
    val voiceSamples = listOf(
        "K Scan scan this",
        "K Scan what am I looking at",
        "K Scan save this",
        "K Scan open on phone",
    )

    /** Settings has its own navigator: capability toggle card + one card per voice sample. */
    private var settingsNavigator = FocusNavigator({ settingsItemCount() })

    /** Voice sample cards shown in Settings; hidden in connected mode (voice loop is phone-side). */
    val settingsVoiceSamples: List<String> get() = if (connectedMode) emptyList() else voiceSamples

    private fun settingsItemCount(): Int = 1 + settingsVoiceSamples.size

    // ----- connected mode (phone bridge) -----

    /** True when a phone bridge is injected and the HUD is machine-driven. */
    val connectedMode: Boolean = phoneBridge != null

    private var connectedMachine: ConnectedRuntimeStateMachine? = null

    /** Connected-runtime UI state; null only in legacy mode. */
    private val _connected = MutableStateFlow<ConnectedUiState?>(null)
    val connected: StateFlow<ConnectedUiState?> = _connected.asStateFlow()

    /** Provider availability for the HUD connection indicator; null in legacy mode. */
    private val _phoneBridgeStatus = MutableStateFlow<PhoneBridgeProviderStatus?>(null)
    val phoneBridgeStatus: StateFlow<PhoneBridgeProviderStatus?> = _phoneBridgeStatus.asStateFlow()

    private val _pairingCode = MutableStateFlow<String?>(null)
    val pairingCode: StateFlow<String?> = _pairingCode.asStateFlow()

    /** Focusable rows for the connected HUD, rebuilt on every state change. */
    private val _connectedItems = MutableStateFlow<List<ConnectedFocusItem>>(emptyList())
    val connectedItems: StateFlow<List<ConnectedFocusItem>> = _connectedItems.asStateFlow()

    /**
     * Transient notice for outbound actions that could not be handed to the
     * bridge at all (unavailable/disabled). Never a success signal.
     */
    private val _actionNotice = MutableStateFlow<String?>(null)
    val actionNotice: StateFlow<String?> = _actionNotice.asStateFlow()

    private var connectedNavigator = FocusNavigator({ _connectedItems.value.size })
    private var ackJob: Job? = null

    /**
     * Wires the connected runtime: provider events feed the machine, machine
     * effects are executed against the provider, and every state change rebuilds
     * the HUD focus list at its metadata-declared default focus.
     */
    private fun startConnectedMode(provider: PhoneBridgeProvider) {
        val machine = ConnectedRuntimeStateMachine()
        connectedMachine = machine
        _screen.value = AppScreen.CONNECTED
        viewModelScope.launch {
            provider.status.collect { _phoneBridgeStatus.value = it }
        }
        viewModelScope.launch {
            provider.pairingCode.collect { _pairingCode.value = it }
        }
        viewModelScope.launch {
            provider.events.collect { machine.on(ConnectedInput.Bridge(it)) }
        }
        viewModelScope.launch {
            machine.effects.collect { executeEffect(it) }
        }
        viewModelScope.launch {
            machine.uiState.collect { ui ->
                _connected.value = ui
                _connectedItems.value = connectedFocusItems(ui)
                connectedNavigator = FocusNavigator(
                    { _connectedItems.value.size },
                    initialIndex = defaultFocusIndex(ui),
                )
                // Leaving RESULTS resolves any pending ack wait: confirmed,
                // navigated away, or superseded — a late timeout must not fire.
                if (ui.state != ConnectedState.RESULTS) {
                    ackJob?.cancel()
                    ackJob = null
                    _actionNotice.value = null
                }
            }
        }
    }

    /** Focus rows per state: metadata actions first, then overlay destinations. */
    internal fun connectedFocusItems(ui: ConnectedUiState): List<ConnectedFocusItem> {
        fun actionItem(action: ConnectedAction, fallback: String): ConnectedFocusItem =
            ConnectedFocusItem(label = actionLabel(ui, action, fallback), action = action)
        val closet = ConnectedFocusItem(label = "Closet", destination = AppScreen.LIBRARY)
        val settings = ConnectedFocusItem(label = "Settings", destination = AppScreen.SETTINGS)
        return when (ui.state) {
            ConnectedState.DISCONNECTED -> listOf(
                actionItem(ConnectedAction.PAIR, "Pair phone"),
                closet,
                settings,
            )
            ConnectedState.PAIRING, ConnectedState.CONNECTED ->
                listOf(actionItem(ConnectedAction.CANCEL, "Cancel"))
            ConnectedState.READY -> listOf(
                actionItem(ConnectedAction.SCAN, "Scan"),
                closet,
                settings,
            )
            ConnectedState.CAPTURE_REQUESTED, ConnectedState.CAPTURING_ON_PHONE,
            ConnectedState.PRIVACY_PROCESSING, ConnectedState.ANALYZING,
            -> listOf(actionItem(ConnectedAction.CANCEL, "Cancel"))
            ConnectedState.RESULTS -> {
                val products = ui.result?.products.orEmpty()
                    .take(MAX_RESULT_ITEMS)
                    .map { product ->
                        ConnectedFocusItem(
                            label = "${product.title} — ${product.brand}",
                            action = ConnectedAction.OPEN_ON_PHONE,
                        )
                    }
                products + listOf(
                    actionItem(ConnectedAction.SAVE, "Save"),
                    actionItem(ConnectedAction.OPEN_ON_PHONE, "Open on phone"),
                    actionItem(ConnectedAction.RETRY, "Retry scan"),
                )
            }
            ConnectedState.ACTION_CONFIRMED -> listOf(actionItem(ConnectedAction.DONE, "Done"))
            ConnectedState.ERROR -> listOf(
                actionItem(ConnectedAction.RETRY, "Retry"),
                actionItem(ConnectedAction.DISMISS, "Dismiss"),
            )
            ConnectedState.RECONNECTING -> listOf(actionItem(ConnectedAction.DISMISS, "Disconnect"))
        }
    }

    /** Label from the state metadata contract, never hardcoded at the call site. */
    private fun actionLabel(ui: ConnectedUiState, action: ConnectedAction, fallback: String): String =
        (listOf(ui.metadata.primaryAction) + ui.metadata.secondaryActions)
            .firstOrNull { it.action == action }
            ?.label
            ?: fallback

    /** Metadata-declared default focus, resolved against the built focus list. */
    private fun defaultFocusIndex(ui: ConnectedUiState): Int {
        val items = _connectedItems.value
        val index = items.indexOfFirst { it.action == ui.metadata.defaultFocus }
        return if (index >= 0) index else 0
    }

    private fun handleConnectedInput(input: GlassesInput) {
        val machine = connectedMachine ?: return
        when (input) {
            is GlassesInput.ScanShortcut -> machine.on(ConnectedInput.ScanTapped)
            is GlassesInput.Up, is GlassesInput.Down -> connectedNavigator.onInput(input)
            is GlassesInput.Select -> activateConnectedItem(connectedNavigator.focusedIndex)
            is GlassesInput.Back, is GlassesInput.Left -> machine.on(ConnectedInput.BackTapped)
            is GlassesInput.Right -> Unit
            is GlassesInput.VoiceCommand -> handleConnectedVoice(machine, input.transcript)
        }
    }

    private fun activateConnectedItem(index: Int) {
        val item = _connectedItems.value.getOrNull(index) ?: return
        item.destination?.let { destination ->
            when (destination) {
                AppScreen.SETTINGS -> {
                    settingsNavigator = FocusNavigator({ settingsItemCount() })
                    _screen.value = AppScreen.SETTINGS
                }
                AppScreen.LIBRARY -> _screen.value = AppScreen.LIBRARY
                else -> Unit
            }
            return
        }
        val machine = connectedMachine ?: return
        when (item.action) {
            ConnectedAction.PAIR -> machine.on(ConnectedInput.PairTapped)
            ConnectedAction.SCAN -> machine.on(ConnectedInput.ScanTapped)
            ConnectedAction.SAVE -> machine.on(ConnectedInput.SaveTapped)
            ConnectedAction.OPEN_ON_PHONE -> machine.on(ConnectedInput.OpenOnPhoneTapped)
            ConnectedAction.RETRY -> machine.on(ConnectedInput.RetryTapped)
            ConnectedAction.CANCEL -> machine.on(ConnectedInput.CancelTapped)
            ConnectedAction.DONE -> machine.on(ConnectedInput.DoneTapped)
            ConnectedAction.DISMISS -> machine.on(ConnectedInput.CancelTapped)
            null -> Unit
        }
    }

    /** Voice in connected mode: mapped to machine intents; the machine guards legality. */
    private fun handleConnectedVoice(machine: ConnectedRuntimeStateMachine, transcript: String) {
        val (action, _) = voiceParser.parse(transcript)
        _lastVoiceAction.value = action
        when (action) {
            VoiceAction.SCAN, VoiceAction.WHAT_AM_I_LOOKING_AT, VoiceAction.FIND_SIMILAR ->
                machine.on(ConnectedInput.ScanTapped)
            VoiceAction.SAVE -> machine.on(ConnectedInput.SaveTapped)
            VoiceAction.OPEN_ON_PHONE -> machine.on(ConnectedInput.OpenOnPhoneTapped)
            VoiceAction.GO_BACK -> machine.on(ConnectedInput.BackTapped)
            else -> Unit
        }
    }

    /** Executes one machine effect against the provider; results are never assumed. */
    private fun executeEffect(effect: ConnectedEffect) {
        val provider = phoneBridge ?: return
        viewModelScope.launch {
            when (effect) {
                ConnectedEffect.RequestPairing -> noteSendResult(provider.requestPairing())
                ConnectedEffect.RequestCapture -> noteSendResult(provider.requestCapture())
                is ConnectedEffect.SaveResult -> sendActionWithAckWatchdog { provider.saveResult(effect.resultId) }
                is ConnectedEffect.OpenOnPhone -> sendActionWithAckWatchdog { provider.openOnPhone(effect.resultId) }
                is ConnectedEffect.RetryScan -> noteSendResult(provider.retryScan(effect.scanId))
                is ConnectedEffect.CancelScan -> noteSendResult(provider.cancelScan(effect.scanId))
            }
        }
    }

    /**
     * Sends an action that requires a companion ack. The ack watchdog is armed
     * only when the frame actually left the glasses; on timeout the machine
     * receives a recoverable ACTION_TIMEOUT and the HUD shows the error card.
     */
    private suspend fun sendActionWithAckWatchdog(send: suspend () -> PhoneBridgeSendResult) {
        when (val result = send()) {
            PhoneBridgeSendResult.Sent -> {
                _actionNotice.value = null
                ackJob?.cancel()
                ackJob = viewModelScope.launch {
                    delay(ackTimeoutMs)
                    connectedMachine?.on(
                        ConnectedInput.Bridge(
                            PhoneBridgeEvent.SessionError(ACTION_TIMEOUT_CODE, recoverable = true),
                        ),
                    )
                }
            }
            else -> noteSendResult(result)
        }
    }

    /** Surfaces a non-Sent provider result as a controlled notice; never throws. */
    private fun noteSendResult(result: PhoneBridgeSendResult) {
        _actionNotice.value = when (result) {
            PhoneBridgeSendResult.Sent -> null
            PhoneBridgeSendResult.Unavailable -> "Bridge unavailable — reconnect your phone"
            PhoneBridgeSendResult.Disabled -> "Phone bridge is disabled"
        }
    }

    /** Home for overlay back-navigation: CONNECTED in connected mode, SCAN otherwise. */
    private fun homeScreen(): AppScreen = if (connectedMode) AppScreen.CONNECTED else AppScreen.SCAN

    init {
        viewModelScope.launch {
            refreshDeviceState()
        }
        phoneBridge?.let { startConnectedMode(it) }
    }

    /** Entry point for local image picker to route into orchestrator. */
    fun onImagePicked(input: ScanInput) {
        if (_isProcessing.value) return
        viewModelScope.launch { runOrchestratorFlow(input) }
    }

    private suspend fun runOrchestratorFlow(input: ScanInput) {
        _isProcessing.value = true
        _errorCode.value = null
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
                showError(userMessage, result.error.code)
            }
            is ScanOrchestratorResult.DryRunReady -> {
                _orchestratorState.value = ScanOrchestratorState.COMPLETE
                // "Ready" here means CONFIGURATION GATE ready only: the dry-run
                // evaluated flags/URL/debug config without any transport, and the
                // image privacy stage has NOT run for real (face masking is not
                // implemented in this build; strict mode fails closed). Never
                // describe this as live analysis readiness.
                _results.value = ResultsUiState(
                    summary = "Dry-run gate ready (config only)",
                    topProducts = emptyList(),
                )
                speech.speakSummary("Dry-run gate ready. Configuration only, not live analysis.")
                _screen.value = if (_hasDisplay.value) AppScreen.RESULTS else AppScreen.SCAN
            }
            is ScanOrchestratorResult.DryRunBlocked -> {
                _orchestratorState.value = ScanOrchestratorState.ERROR_RETRY
                showError("Dry run blocked", ScanErrorCode.CONFIGURATION_REQUIRED)
            }
            is ScanOrchestratorResult.ConfigBlocked -> {
                _orchestratorState.value = ScanOrchestratorState.ERROR_RETRY
                showError("Backend config blocked", ScanErrorCode.CONFIGURATION_REQUIRED)
            }
        }

        _isProcessing.value = false
    }

    fun onInput(input: GlassesInput) {
        if (connectedMode) {
            // Connected mode: the machine owns CONNECTED; Closet/Settings remain
            // as legacy overlay screens. No other legacy screen is reachable.
            when (_screen.value) {
                AppScreen.CONNECTED -> handleConnectedInput(input)
                AppScreen.SETTINGS -> handleSettingsInput(input)
                AppScreen.LIBRARY -> handleLibraryInput(input)
                else -> Unit
            }
            return
        }
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
        _errorCode.value = null
        _screen.value = homeScreen()
    }

    private fun routeFocusInput(input: GlassesInput) {
        when (_screen.value) {
            AppScreen.SCAN -> handleScanScreenInput(input)
            AppScreen.RESULTS -> handleResultsScreenInput(input)
            AppScreen.SETTINGS -> handleSettingsInput(input)
            AppScreen.LIBRARY -> handleLibraryInput(input)
            // Select retries; Back/Left also exit the error state — the primary
            // navigation key must never dead-end on a nested screen.
            AppScreen.ERROR -> if (input is GlassesInput.Select || input is GlassesInput.Back || input is GlassesInput.Left) retryFromError()
            AppScreen.PROCESSING -> Unit
            // Reachable only defensively: onInput short-circuits connected mode.
            AppScreen.CONNECTED -> handleConnectedInput(input)
        }
    }

    private fun handleScanScreenInput(input: GlassesInput) {
        when (val event = focusNavigator.onInput(input)) {
            is FocusEvent.Activated -> when (actionItems[event.index]) {
                "Scan" -> startScanIfIdle()
                "Closet" -> _screen.value = AppScreen.LIBRARY
                "Settings" -> {
                    settingsNavigator = FocusNavigator({ settingsItemCount() })
                    _screen.value = AppScreen.SETTINGS
                }
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
                                _screen.value = homeScreen()
                                focusNavigator = FocusNavigator({ actionItems.size })
                            }
                        }
                    }
                }
            }
            is GlassesInput.Back, is GlassesInput.Left -> {
                _screen.value = homeScreen()
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
        when (val event = settingsNavigator.onInput(input)) {
            is FocusEvent.Activated -> {
                if (!connectedMode && event.index == 0) {
                    toggleAudioOnlyMode(_hasDisplay.value)
                } else {
                    settingsVoiceSamples.getOrNull(event.index - 1)?.let { simulateVoice(it) }
                }
            }
            is FocusEvent.Back -> _screen.value = homeScreen()
            else -> Unit
        }
    }

    private fun handleLibraryInput(input: GlassesInput) {
        if (input is GlassesInput.Back || input is GlassesInput.Left) {
            _screen.value = homeScreen()
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
        // Voice-mapped presses are not re-routed while on SETTINGS: the settings
        // voice cards inject these same phrases, so re-routing a mapped Select
        // would re-activate the card and loop.
        mappedInput?.let {
            if (it !is GlassesInput.ScanShortcut && _screen.value != AppScreen.SETTINGS) routeFocusInput(it)
        }
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
            showError("Capture failed. Please check camera access and retry.", ScanErrorCode.CAPTURE_UNAVAILABLE)
        } catch (e: Exception) {
            showError("Something went wrong. Please retry.", ScanErrorCode.UNKNOWN_SAFE_ERROR)
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

    private suspend fun showError(message: String, code: ScanErrorCode) {
        _errorMessage.value = message
        _errorCode.value = code
        scanSession = scanSession.copy(status = ScanStatus.ERROR)
        _screen.value = AppScreen.ERROR
        speech.speakSummary(message)
    }

    fun focusedIndex(): Int = when (_screen.value) {
        AppScreen.SETTINGS -> settingsNavigator.focusedIndex
        AppScreen.CONNECTED -> connectedNavigator.focusedIndex
        else -> focusNavigator.focusedIndex
    }

    companion object {
        /** Bounded wait for the companion's action ack before the HUD errors out. */
        const val DEFAULT_ACK_TIMEOUT_MS: Long = 3_000L

        /** Recoverable error code injected by the ack watchdog. */
        internal const val ACTION_TIMEOUT_CODE = "ACTION_TIMEOUT"

        /** Maximum product rows rendered (and focusable) in the RESULTS state. */
        internal const val MAX_RESULT_ITEMS = 5
    }
}

/**
 * One focusable row on the connected HUD: either a machine action (its label
 * comes from the state metadata) or an overlay destination (Closet/Settings).
 */
data class ConnectedFocusItem(
    val label: String,
    val action: ConnectedAction? = null,
    val destination: AppScreen? = null,
)
