package com.kscan.glasses.phonebridge

import com.kscan.glasses.scan.ScanErrorCode

/**
 * Domain-level bridge events consumed by the runtime (state machine, HUD).
 *
 * Produced ONLY from validator-accepted [PhoneBridgeMessage]s — rejected
 * frames never become events (the validator logs them code-only). Liveness
 * frames (connection.ping / connection.pong) are transport-internal and are
 * intentionally not events.
 */
sealed interface PhoneBridgeEvent {
    data class PairApproved(val sessionId: String, val sessionExpiresAt: Long) : PhoneBridgeEvent
    data class PairDenied(val reason: PairDenyReason) : PhoneBridgeEvent
    data object PairExpired : PhoneBridgeEvent

    data class SessionReady(val phoneAppVersion: String, val features: List<String>) : PhoneBridgeEvent
    data class SessionRevoked(val reason: SessionRevokeReason) : PhoneBridgeEvent
    data class SessionError(val code: String, val recoverable: Boolean) : PhoneBridgeEvent

    data class CaptureStarted(val captureId: String) : PhoneBridgeEvent
    data class CaptureCompleted(val captureId: String, val captureRef: String) : PhoneBridgeEvent
    data class CaptureFailed(val captureId: String, val code: ScanErrorCode) : PhoneBridgeEvent

    data class ScanProcessing(val scanId: String) : PhoneBridgeEvent
    data class ScanProgress(val scanId: String, val stage: ScanStage, val percent: Int) : PhoneBridgeEvent
    data class ScanCompleted(val scanId: String, val resultId: String) : PhoneBridgeEvent
    data class ScanFailed(val scanId: String, val code: ScanErrorCode) : PhoneBridgeEvent

    data class ResultShown(val result: ResultPayload) : PhoneBridgeEvent
    data class ResultUpdated(val result: ResultPayload, val revision: Int) : PhoneBridgeEvent
    data class ResultDismissed(val resultId: String) : PhoneBridgeEvent

    data class ConnectionLost(val reason: ConnectionLostReason) : PhoneBridgeEvent
    data object ConnectionRestored : PhoneBridgeEvent
}

/** Maps an accepted wire message to its domain event; null for liveness frames. */
fun PhoneBridgeMessage.toEvent(): PhoneBridgeEvent? = when (this) {
    is PhoneBridgeMessage.PairRequest -> null // glasses-originated; not surfaced
    is PhoneBridgeMessage.PairApproved -> PhoneBridgeEvent.PairApproved(sessionId, payload.sessionExpiresAt)
    is PhoneBridgeMessage.PairDenied -> PhoneBridgeEvent.PairDenied(payload.reason)
    is PhoneBridgeMessage.PairExpired -> PhoneBridgeEvent.PairExpired
    is PhoneBridgeMessage.SessionReady -> PhoneBridgeEvent.SessionReady(payload.phoneAppVersion, payload.features)
    is PhoneBridgeMessage.SessionRevoked -> PhoneBridgeEvent.SessionRevoked(payload.reason)
    is PhoneBridgeMessage.SessionError -> PhoneBridgeEvent.SessionError(payload.code, payload.recoverable)
    is PhoneBridgeMessage.CaptureRequest -> null // glasses-originated; not surfaced
    is PhoneBridgeMessage.CaptureStarted -> PhoneBridgeEvent.CaptureStarted(payload.captureId)
    is PhoneBridgeMessage.CaptureCompleted -> PhoneBridgeEvent.CaptureCompleted(payload.captureId, payload.captureRef)
    is PhoneBridgeMessage.CaptureFailed -> PhoneBridgeEvent.CaptureFailed(payload.captureId, payload.code)
    is PhoneBridgeMessage.ScanProcessing -> PhoneBridgeEvent.ScanProcessing(payload.scanId)
    is PhoneBridgeMessage.ScanProgress -> PhoneBridgeEvent.ScanProgress(payload.scanId, payload.stage, payload.percent)
    is PhoneBridgeMessage.ScanCompleted -> PhoneBridgeEvent.ScanCompleted(payload.scanId, payload.resultId)
    is PhoneBridgeMessage.ScanFailed -> PhoneBridgeEvent.ScanFailed(payload.scanId, payload.code)
    is PhoneBridgeMessage.ResultShow -> PhoneBridgeEvent.ResultShown(payload.result)
    is PhoneBridgeMessage.ResultUpdate -> PhoneBridgeEvent.ResultUpdated(payload.result, payload.revision)
    is PhoneBridgeMessage.ResultDismiss -> PhoneBridgeEvent.ResultDismissed(payload.resultId)
    is PhoneBridgeMessage.ActionSave,
    is PhoneBridgeMessage.ActionOpenOnPhone,
    is PhoneBridgeMessage.ActionRetry,
    is PhoneBridgeMessage.ActionCancel,
    -> null // glasses-originated; not surfaced
    is PhoneBridgeMessage.ConnectionPing,
    is PhoneBridgeMessage.ConnectionPong,
    -> null // transport liveness; not surfaced
    is PhoneBridgeMessage.ConnectionLost -> PhoneBridgeEvent.ConnectionLost(payload.reason)
    is PhoneBridgeMessage.ConnectionRestored -> PhoneBridgeEvent.ConnectionRestored
}
