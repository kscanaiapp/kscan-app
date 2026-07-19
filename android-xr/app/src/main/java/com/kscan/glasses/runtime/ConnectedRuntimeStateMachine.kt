package com.kscan.glasses.runtime

import com.kscan.glasses.phonebridge.PhoneBridgeEvent
import com.kscan.glasses.phonebridge.ResultPayload
import com.kscan.glasses.phonebridge.ScanStage
import com.kscan.glasses.phonebridge.SessionRevokeReason
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/** The 12 authoritative connected-runtime states. Single source of truth — no parallel Boolean flags. */
enum class ConnectedState {
    DISCONNECTED,
    PAIRING,
    CONNECTED,
    READY,
    CAPTURE_REQUESTED,
    CAPTURING_ON_PHONE,
    PRIVACY_PROCESSING,
    ANALYZING,
    RESULTS,
    ACTION_CONFIRMED,
    ERROR,
    RECONNECTING,
}

enum class ProgressKind { NONE, INDETERMINATE, BOUNDED }

data class ProgressSpec(val kind: ProgressKind, val percent: Int? = null)

/** User-invokable actions surfaced on the HUD. */
enum class ConnectedAction { PAIR, SCAN, SAVE, OPEN_ON_PHONE, RETRY, CANCEL, DONE, DISMISS }

data class ActionSpec(val action: ConnectedAction, val label: String)

/** Where the runtime goes when the user recovers from an error. */
enum class RecoveryBehavior { NONE, RETRY_PAIRING, RETURN_READY, RETURN_DISCONNECTED }

enum class BackBehavior { NONE, TO_DISCONNECTED, TO_READY }

enum class CancelBehavior { NONE, CANCEL_PAIRING, CANCEL_SCAN, TO_DISCONNECTED, TO_READY }

/** Declarative timeout contract for the HUD/runtime driver; the machine itself is timer-free. */
data class TimeoutSpec(val durationMs: Long?, val description: String) {
    companion object {
        val NONE: TimeoutSpec = TimeoutSpec(null, "no timeout")
    }
}

/** Everything the HUD needs to render a state, expressed as data. */
data class ConnectedStateMetadata(
    val title: String,
    val supportingCopy: String,
    val progress: ProgressSpec,
    val primaryAction: ActionSpec,
    val secondaryActions: List<ActionSpec>,
    val defaultFocus: ConnectedAction,
    val timeout: TimeoutSpec,
    val recovery: RecoveryBehavior,
    val back: BackBehavior,
    val cancel: CancelBehavior,
)

/** Immutable snapshot consumed by the HUD. */
data class ConnectedUiState(
    val state: ConnectedState,
    val metadata: ConnectedStateMetadata,
    val scanId: String? = null,
    val resultId: String? = null,
    val progressPercent: Int? = null,
    val errorCode: String? = null,
    /** Structured result payload while in RESULTS/ACTION_CONFIRMED; null otherwise. */
    val result: ResultPayload? = null,
    /** Which outbound action the companion confirmed (SAVE or OPEN_ON_PHONE). */
    val confirmedAction: ConnectedAction? = null,
    /** Why the session ended, when the phone revoked it. Cleared on re-pairing. */
    val disconnectReason: SessionRevokeReason? = null,
)

/** Inputs: validated bridge events plus user intents. */
sealed interface ConnectedInput {
    data class Bridge(val event: PhoneBridgeEvent) : ConnectedInput

    data object PairTapped : ConnectedInput
    data object ScanTapped : ConnectedInput
    data object SaveTapped : ConnectedInput
    data object OpenOnPhoneTapped : ConnectedInput
    data object RetryTapped : ConnectedInput
    data object CancelTapped : ConnectedInput
    data object BackTapped : ConnectedInput
    data object DoneTapped : ConnectedInput

    /** Fired by the runtime driver when a state's declared timeout elapses. */
    data object OperationTimeout : ConnectedInput
}

/** Side effects the runtime driver executes (provider calls). */
sealed interface ConnectedEffect {
    data object RequestPairing : ConnectedEffect
    data object RequestCapture : ConnectedEffect
    data class SaveResult(val resultId: String) : ConnectedEffect
    data class OpenOnPhone(val resultId: String) : ConnectedEffect
    data class RetryScan(val scanId: String) : ConnectedEffect
    data class CancelScan(val scanId: String) : ConnectedEffect
}

/**
 * THE one authoritative owner of the Google XR connected state.
 *
 * Pure Kotlin, no Compose, fully testable. Consumes ONLY validated bridge
 * events ([PhoneBridgeEvent] — rejected frames never reach this class) and
 * user intents; emits [ConnectedUiState] snapshots and [ConnectedEffect]s.
 *
 * Invariants:
 * - Exactly one [ConnectedState] at any time; no independent Boolean flags.
 * - A stale completion (scanId mismatch) never overwrites a newer scan.
 * - A duplicate completion never produces a duplicate visible result.
 * - Session revocation from any session state lands in DISCONNECTED.
 * - Connection loss from any active state lands in RECONNECTING; restore
 *   returns to the prior safe state, or ERROR when unrecoverable.
 */
class ConnectedRuntimeStateMachine {

    private val _uiState = MutableStateFlow(
        ConnectedUiState(state = ConnectedState.DISCONNECTED, metadata = metadataFor(ConnectedState.DISCONNECTED)),
    )
    val uiState: StateFlow<ConnectedUiState> = _uiState.asStateFlow()

    private val _effects = MutableSharedFlow<ConnectedEffect>(extraBufferCapacity = EFFECT_BUFFER)
    val effects: SharedFlow<ConnectedEffect> = _effects.asSharedFlow()

    // ----- context (derived from the single state, never independent flags) -----
    private var state: ConnectedState = ConnectedState.DISCONNECTED
    private var scanId: String? = null
    private var resultId: String? = null
    private var progressPercent: Int? = null
    private var errorCode: String? = null
    private var errorRecovery: RecoveryBehavior = RecoveryBehavior.NONE
    private var stateBeforeReconnect: ConnectedState? = null
    private var resultPayload: ResultPayload? = null
    private var pendingAction: ConnectedAction? = null
    private var confirmedAction: ConnectedAction? = null
    private var disconnectReason: SessionRevokeReason? = null

    fun on(input: ConnectedInput) {
        when (input) {
            is ConnectedInput.Bridge -> onBridgeEvent(input.event)
            ConnectedInput.PairTapped -> if (state == ConnectedState.DISCONNECTED) {
                disconnectReason = null
                transition(ConnectedState.PAIRING, clearContext = true)
                emit(ConnectedEffect.RequestPairing)
            }
            ConnectedInput.ScanTapped -> if (state == ConnectedState.READY) {
                transition(ConnectedState.CAPTURE_REQUESTED, clearContext = true)
                emit(ConnectedEffect.RequestCapture)
            }
            ConnectedInput.SaveTapped -> if (state == ConnectedState.RESULTS) {
                pendingAction = ConnectedAction.SAVE
                resultId?.let { emit(ConnectedEffect.SaveResult(it)) }
            }
            ConnectedInput.OpenOnPhoneTapped -> if (state == ConnectedState.RESULTS) {
                pendingAction = ConnectedAction.OPEN_ON_PHONE
                resultId?.let { emit(ConnectedEffect.OpenOnPhone(it)) }
            }
            ConnectedInput.RetryTapped -> when (state) {
                ConnectedState.RESULTS -> {
                    // Transition before emitting: a synchronous companion ack must
                    // never be processed against the pre-transition state.
                    val id = scanId
                    transition(ConnectedState.CAPTURE_REQUESTED, clearContext = true)
                    id?.let { emit(ConnectedEffect.RetryScan(it)) }
                }
                ConnectedState.ERROR -> when (errorRecovery) {
                    RecoveryBehavior.RETRY_PAIRING -> {
                        transition(ConnectedState.PAIRING, clearContext = true)
                        emit(ConnectedEffect.RequestPairing)
                    }
                    RecoveryBehavior.RETURN_READY -> transition(ConnectedState.READY, clearContext = true)
                    else -> transition(ConnectedState.DISCONNECTED, clearContext = true)
                }
                else -> Unit
            }
            ConnectedInput.CancelTapped -> when (state) {
                ConnectedState.PAIRING, ConnectedState.CONNECTED ->
                    transition(ConnectedState.DISCONNECTED, clearContext = true)
                ConnectedState.CAPTURE_REQUESTED, ConnectedState.CAPTURING_ON_PHONE,
                ConnectedState.PRIVACY_PROCESSING, ConnectedState.ANALYZING,
                -> cancelActiveScan()
                ConnectedState.RESULTS, ConnectedState.ERROR, ConnectedState.RECONNECTING ->
                    transition(
                        if (state == ConnectedState.RESULTS) ConnectedState.READY else ConnectedState.DISCONNECTED,
                        clearContext = true,
                    )
                else -> Unit
            }
            ConnectedInput.BackTapped -> when (state) {
                ConnectedState.PAIRING, ConnectedState.CONNECTED,
                ConnectedState.ERROR, ConnectedState.RECONNECTING,
                -> transition(ConnectedState.DISCONNECTED, clearContext = true)
                ConnectedState.CAPTURE_REQUESTED, ConnectedState.CAPTURING_ON_PHONE,
                ConnectedState.PRIVACY_PROCESSING, ConnectedState.ANALYZING,
                -> cancelActiveScan()
                ConnectedState.RESULTS, ConnectedState.ACTION_CONFIRMED ->
                    transition(ConnectedState.READY, clearContext = true)
                else -> Unit
            }
            ConnectedInput.DoneTapped -> if (state == ConnectedState.ACTION_CONFIRMED) {
                transition(ConnectedState.READY, clearContext = true)
            }
            ConnectedInput.OperationTimeout -> when (state) {
                ConnectedState.PAIRING, ConnectedState.CONNECTED ->
                    error(TIMEOUT_PAIRING, RecoveryBehavior.RETRY_PAIRING)
                ConnectedState.CAPTURE_REQUESTED, ConnectedState.CAPTURING_ON_PHONE,
                ConnectedState.PRIVACY_PROCESSING, ConnectedState.ANALYZING,
                -> error(TIMEOUT_SCAN, RecoveryBehavior.RETURN_READY)
                ConnectedState.RECONNECTING ->
                    error(TIMEOUT_RECONNECT, RecoveryBehavior.RETURN_DISCONNECTED)
                else -> Unit
            }
        }
    }

    private fun onBridgeEvent(event: PhoneBridgeEvent) {
        when (event) {
            is PhoneBridgeEvent.PairApproved ->
                if (state == ConnectedState.PAIRING) transition(ConnectedState.CONNECTED)
            is PhoneBridgeEvent.PairDenied ->
                if (state == ConnectedState.PAIRING) error(ERROR_PAIRING_DENIED, RecoveryBehavior.RETRY_PAIRING)
            PhoneBridgeEvent.PairExpired ->
                if (state == ConnectedState.PAIRING) error(ERROR_PAIRING_EXPIRED, RecoveryBehavior.RETRY_PAIRING)
            is PhoneBridgeEvent.SessionReady ->
                if (state == ConnectedState.CONNECTED) transition(ConnectedState.READY)
            is PhoneBridgeEvent.SessionRevoked ->
                if (state != ConnectedState.DISCONNECTED) {
                    disconnectReason = event.reason
                    transition(ConnectedState.DISCONNECTED, clearContext = true)
                }
            is PhoneBridgeEvent.SessionError ->
                if (state in SESSION_STATES) {
                    error(event.code, if (event.recoverable) RecoveryBehavior.RETURN_READY else RecoveryBehavior.RETURN_DISCONNECTED)
                }
            is PhoneBridgeEvent.CaptureStarted ->
                if (state == ConnectedState.CAPTURE_REQUESTED) transition(ConnectedState.CAPTURING_ON_PHONE)
            is PhoneBridgeEvent.CaptureCompleted ->
                if (state == ConnectedState.CAPTURING_ON_PHONE) transition(ConnectedState.PRIVACY_PROCESSING)
            is PhoneBridgeEvent.CaptureFailed ->
                if (state == ConnectedState.CAPTURE_REQUESTED || state == ConnectedState.CAPTURING_ON_PHONE) {
                    error(event.code.name, RecoveryBehavior.RETURN_READY)
                }
            is PhoneBridgeEvent.ScanProcessing ->
                if (state == ConnectedState.CAPTURE_REQUESTED ||
                    state == ConnectedState.CAPTURING_ON_PHONE ||
                    state == ConnectedState.PRIVACY_PROCESSING
                ) {
                    scanId = event.scanId
                    transition(ConnectedState.PRIVACY_PROCESSING)
                }
            is PhoneBridgeEvent.ScanProgress ->
                if (event.scanId == scanId) {
                    when (state) {
                        ConnectedState.PRIVACY_PROCESSING ->
                            if (event.stage == ScanStage.PRIVACY_PROCESSING) {
                                transition(ConnectedState.PRIVACY_PROCESSING, percent = event.percent)
                            } else {
                                transition(ConnectedState.ANALYZING, percent = event.percent)
                            }
                        ConnectedState.ANALYZING ->
                            transition(ConnectedState.ANALYZING, percent = event.percent)
                        else -> Unit
                    }
                }
            is PhoneBridgeEvent.ScanCompleted ->
                // Stale completions (scanId mismatch) and duplicate completions
                // (already in RESULTS) are ignored: a newer scan is never
                // overwritten and no duplicate visible result is produced.
                if (event.scanId == scanId &&
                    (state == ConnectedState.PRIVACY_PROCESSING || state == ConnectedState.ANALYZING)
                ) {
                    resultId = event.resultId
                    transition(ConnectedState.RESULTS)
                }
            is PhoneBridgeEvent.ScanFailed ->
                if (event.scanId == scanId &&
                    (state == ConnectedState.CAPTURING_ON_PHONE ||
                        state == ConnectedState.PRIVACY_PROCESSING ||
                        state == ConnectedState.ANALYZING)
                ) {
                    error(event.code.name, RecoveryBehavior.RETURN_READY)
                }
            is PhoneBridgeEvent.ResultShown -> when {
                state == ConnectedState.RESULTS && event.result.resultId == resultId -> {
                    resultPayload = event.result
                    transition(ConnectedState.RESULTS) // in-place refresh; never a duplicate
                }
                state == ConnectedState.PRIVACY_PROCESSING || state == ConnectedState.ANALYZING -> {
                    resultId = event.result.resultId
                    resultPayload = event.result
                    transition(ConnectedState.RESULTS)
                }
                else -> Unit
            }
            is PhoneBridgeEvent.ResultUpdated ->
                if (state == ConnectedState.RESULTS) {
                    // Refresh structured payload in place. Visible confirmation is
                    // ONLY allowed when the user has an outstanding action pending
                    // an ack — never treat an unsolicited result.update as success.
                    resultPayload = event.result
                    val action = pendingAction
                    if (action != null) {
                        confirmedAction = action
                        pendingAction = null
                        transition(ConnectedState.ACTION_CONFIRMED)
                    } else {
                        transition(ConnectedState.RESULTS)
                    }
                }
            is PhoneBridgeEvent.ResultDismissed ->
                if (state == ConnectedState.RESULTS) transition(ConnectedState.READY, clearContext = true)
            is PhoneBridgeEvent.ConnectionLost ->
                if (state != ConnectedState.DISCONNECTED &&
                    state != ConnectedState.ERROR &&
                    state != ConnectedState.RECONNECTING
                ) {
                    stateBeforeReconnect = state
                    transition(ConnectedState.RECONNECTING)
                }
            PhoneBridgeEvent.ConnectionRestored ->
                if (state == ConnectedState.RECONNECTING) {
                    val prior = stateBeforeReconnect
                    stateBeforeReconnect = null
                    if (prior != null) {
                        transition(prior, percent = null)
                    } else {
                        error(ERROR_RECONNECT_UNRECOVERABLE, RecoveryBehavior.RETURN_DISCONNECTED)
                    }
                }
        }
    }

    private fun cancelActiveScan() {
        // Transition before emitting: the companion's cancel ack (scan.failed)
        // must arrive to the settled READY state, never to the cancelled scan.
        val id = scanId
        transition(ConnectedState.READY, clearContext = true)
        id?.let { emit(ConnectedEffect.CancelScan(it)) }
    }

    private fun error(code: String, recovery: RecoveryBehavior) {
        stateBeforeReconnect = null
        errorCode = code
        errorRecovery = recovery
        scanId = null
        resultId = null
        progressPercent = null
        resultPayload = null
        confirmedAction = null
        pendingAction = null
        transition(ConnectedState.ERROR)
    }

    private fun transition(
        target: ConnectedState,
        clearContext: Boolean = false,
        percent: Int? = null,
    ) {
        if (clearContext) {
            scanId = null
            resultId = null
            errorCode = null
            errorRecovery = RecoveryBehavior.NONE
            resultPayload = null
            confirmedAction = null
            pendingAction = null
            // disconnectReason survives clearContext so the DISCONNECTED card can
            // explain why the session ended; it is cleared on the next PairTapped.
            if (target != ConnectedState.RECONNECTING) stateBeforeReconnect = null
        }
        progressPercent = percent
        state = target
        _uiState.value = ConnectedUiState(
            state = state,
            metadata = metadataFor(state, progressPercent, errorCode, errorRecovery),
            scanId = scanId,
            resultId = resultId,
            progressPercent = progressPercent,
            errorCode = errorCode,
            result = resultPayload,
            confirmedAction = confirmedAction,
            disconnectReason = disconnectReason,
        )
    }

    private fun emit(effect: ConnectedEffect) {
        _effects.tryEmit(effect)
    }

    companion object {
        private const val EFFECT_BUFFER = 16

        internal const val ERROR_PAIRING_DENIED = "PAIRING_DENIED"
        internal const val ERROR_PAIRING_EXPIRED = "PAIRING_EXPIRED"
        internal const val ERROR_RECONNECT_UNRECOVERABLE = "RECONNECT_UNRECOVERABLE"
        internal const val TIMEOUT_PAIRING = "PAIRING_TIMEOUT"
        internal const val TIMEOUT_SCAN = "SCAN_TIMEOUT"
        internal const val TIMEOUT_RECONNECT = "RECONNECT_TIMEOUT"

        private val SESSION_STATES: Set<ConnectedState> = setOf(
            ConnectedState.CONNECTED,
            ConnectedState.READY,
            ConnectedState.CAPTURE_REQUESTED,
            ConnectedState.CAPTURING_ON_PHONE,
            ConnectedState.PRIVACY_PROCESSING,
            ConnectedState.ANALYZING,
            ConnectedState.RESULTS,
            ConnectedState.ACTION_CONFIRMED,
            ConnectedState.RECONNECTING,
        )

        /** Per-state HUD contract. Percent is injected for bounded progress states. */
        fun metadataFor(
            state: ConnectedState,
            percent: Int? = null,
            errorCode: String? = null,
            errorRecovery: RecoveryBehavior = RecoveryBehavior.NONE,
        ): ConnectedStateMetadata = when (state) {
            ConnectedState.DISCONNECTED -> ConnectedStateMetadata(
                title = "Not connected",
                supportingCopy = "Pair with your phone to start scanning.",
                progress = ProgressSpec(ProgressKind.NONE),
                primaryAction = ActionSpec(ConnectedAction.PAIR, "Pair phone"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.PAIR,
                timeout = TimeoutSpec.NONE,
                recovery = RecoveryBehavior.NONE,
                back = BackBehavior.NONE,
                cancel = CancelBehavior.NONE,
            )
            ConnectedState.PAIRING -> ConnectedStateMetadata(
                title = "Pairing",
                supportingCopy = "Approve the connection on your phone.",
                progress = ProgressSpec(ProgressKind.INDETERMINATE),
                primaryAction = ActionSpec(ConnectedAction.CANCEL, "Cancel"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.CANCEL,
                timeout = TimeoutSpec(60_000L, "pairing expires without a phone decision"),
                recovery = RecoveryBehavior.RETRY_PAIRING,
                back = BackBehavior.TO_DISCONNECTED,
                cancel = CancelBehavior.CANCEL_PAIRING,
            )
            ConnectedState.CONNECTED -> ConnectedStateMetadata(
                title = "Connected",
                supportingCopy = "Finishing secure setup with your phone.",
                progress = ProgressSpec(ProgressKind.INDETERMINATE),
                primaryAction = ActionSpec(ConnectedAction.CANCEL, "Cancel"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.CANCEL,
                timeout = TimeoutSpec(15_000L, "session.ready wait"),
                recovery = RecoveryBehavior.RETRY_PAIRING,
                back = BackBehavior.TO_DISCONNECTED,
                cancel = CancelBehavior.CANCEL_PAIRING,
            )
            ConnectedState.READY -> ConnectedStateMetadata(
                title = "Ready",
                supportingCopy = "Point at an item and scan.",
                progress = ProgressSpec(ProgressKind.NONE),
                primaryAction = ActionSpec(ConnectedAction.SCAN, "Scan"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.SCAN,
                timeout = TimeoutSpec.NONE,
                recovery = RecoveryBehavior.NONE,
                back = BackBehavior.NONE,
                cancel = CancelBehavior.NONE,
            )
            ConnectedState.CAPTURE_REQUESTED -> ConnectedStateMetadata(
                title = "Requesting capture",
                supportingCopy = "Asking your phone to capture.",
                progress = ProgressSpec(ProgressKind.INDETERMINATE),
                primaryAction = ActionSpec(ConnectedAction.CANCEL, "Cancel"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.CANCEL,
                timeout = TimeoutSpec(30_000L, "capture request wait"),
                recovery = RecoveryBehavior.RETURN_READY,
                back = BackBehavior.TO_READY,
                cancel = CancelBehavior.CANCEL_SCAN,
            )
            ConnectedState.CAPTURING_ON_PHONE -> ConnectedStateMetadata(
                title = "Capturing on phone",
                supportingCopy = "Hold steady while your phone captures.",
                progress = ProgressSpec(ProgressKind.INDETERMINATE),
                primaryAction = ActionSpec(ConnectedAction.CANCEL, "Cancel"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.CANCEL,
                timeout = TimeoutSpec(45_000L, "capture wait"),
                recovery = RecoveryBehavior.RETURN_READY,
                back = BackBehavior.TO_READY,
                cancel = CancelBehavior.CANCEL_SCAN,
            )
            ConnectedState.PRIVACY_PROCESSING -> ConnectedStateMetadata(
                title = "Protecting privacy",
                supportingCopy = "Masking sensitive details before analysis.",
                progress = ProgressSpec(ProgressKind.BOUNDED, percent),
                primaryAction = ActionSpec(ConnectedAction.CANCEL, "Cancel"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.CANCEL,
                timeout = TimeoutSpec(45_000L, "privacy processing wait"),
                recovery = RecoveryBehavior.RETURN_READY,
                back = BackBehavior.TO_READY,
                cancel = CancelBehavior.CANCEL_SCAN,
            )
            ConnectedState.ANALYZING -> ConnectedStateMetadata(
                title = "Analyzing style",
                supportingCopy = "Matching your item across retail and resale.",
                progress = ProgressSpec(ProgressKind.BOUNDED, percent),
                primaryAction = ActionSpec(ConnectedAction.CANCEL, "Cancel"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.CANCEL,
                timeout = TimeoutSpec(60_000L, "analysis wait"),
                recovery = RecoveryBehavior.RETURN_READY,
                back = BackBehavior.TO_READY,
                cancel = CancelBehavior.CANCEL_SCAN,
            )
            ConnectedState.RESULTS -> ConnectedStateMetadata(
                title = "Match found",
                supportingCopy = "Review matches and choose an action.",
                progress = ProgressSpec(ProgressKind.NONE),
                primaryAction = ActionSpec(ConnectedAction.SAVE, "Save"),
                secondaryActions = listOf(
                    ActionSpec(ConnectedAction.OPEN_ON_PHONE, "Open on phone"),
                    ActionSpec(ConnectedAction.RETRY, "Retry scan"),
                ),
                defaultFocus = ConnectedAction.SAVE,
                timeout = TimeoutSpec.NONE,
                recovery = RecoveryBehavior.NONE,
                back = BackBehavior.TO_READY,
                cancel = CancelBehavior.TO_READY,
            )
            ConnectedState.ACTION_CONFIRMED -> ConnectedStateMetadata(
                title = "Saved",
                supportingCopy = "Saved to your library on your phone.",
                progress = ProgressSpec(ProgressKind.NONE),
                primaryAction = ActionSpec(ConnectedAction.DONE, "Done"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.DONE,
                timeout = TimeoutSpec.NONE,
                recovery = RecoveryBehavior.NONE,
                back = BackBehavior.TO_READY,
                cancel = CancelBehavior.TO_READY,
            )
            ConnectedState.ERROR -> ConnectedStateMetadata(
                title = "Something went wrong",
                supportingCopy = if (errorCode != null) {
                    "We couldn't complete that ($errorCode). You can retry."
                } else {
                    "We couldn't complete that. You can retry."
                },
                progress = ProgressSpec(ProgressKind.NONE),
                primaryAction = ActionSpec(ConnectedAction.RETRY, "Retry"),
                secondaryActions = listOf(ActionSpec(ConnectedAction.DISMISS, "Dismiss")),
                defaultFocus = ConnectedAction.RETRY,
                timeout = TimeoutSpec.NONE,
                recovery = errorRecovery,
                back = BackBehavior.TO_DISCONNECTED,
                cancel = CancelBehavior.TO_DISCONNECTED,
            )
            ConnectedState.RECONNECTING -> ConnectedStateMetadata(
                title = "Reconnecting",
                supportingCopy = "Connection to your phone was lost. Reconnecting.",
                progress = ProgressSpec(ProgressKind.INDETERMINATE),
                primaryAction = ActionSpec(ConnectedAction.DISMISS, "Disconnect"),
                secondaryActions = emptyList(),
                defaultFocus = ConnectedAction.DISMISS,
                timeout = TimeoutSpec(30_000L, "reconnect wait"),
                recovery = RecoveryBehavior.NONE,
                back = BackBehavior.TO_DISCONNECTED,
                cancel = CancelBehavior.TO_DISCONNECTED,
            )
        }
    }
}
