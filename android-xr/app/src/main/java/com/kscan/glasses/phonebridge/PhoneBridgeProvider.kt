package com.kscan.glasses.phonebridge

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/** Availability of the active phone-bridge provider, for controlled UI states. */
enum class PhoneBridgeProviderStatus {
    /** Provider is live; frames flow. */
    ACTIVE,

    /** Bridge is unavailable (e.g. real transport not yet implemented, or link lost). */
    UNAVAILABLE,

    /** Bridge is explicitly disabled by configuration. */
    DISABLED,
}

/**
 * Result of an outbound provider call. Providers never throw for ordinary
 * unavailability — a non-[Sent] result is a controlled state the UI can render.
 */
sealed interface PhoneBridgeSendResult {
    /** Frame was validated and handed to the transport. */
    data object Sent : PhoneBridgeSendResult

    /** Bridge is currently unavailable; nothing was sent. */
    data object Unavailable : PhoneBridgeSendResult

    /** Bridge is disabled by configuration; nothing was sent. */
    data object Disabled : PhoneBridgeSendResult
}

/**
 * Runtime-facing seam over the versioned phone bridge.
 *
 * Exactly three implementations exist:
 * - `mock/MockPhoneBridgeProvider` — in-memory mock companion, debug-only and
 *   only when explicitly enabled via BuildConfig.KSCAN_DEBUG_MOCK_PHONE_BRIDGE.
 * - [FutureRealPhoneBridgeProvider] — explicit stub for the not-yet-built real
 *   transport; fails safe with [PhoneBridgeProviderStatus.UNAVAILABLE].
 * - [DisabledPhoneBridgeProvider] — controlled disabled state.
 *
 * Implementations must use structured concurrency: [close] cancels all
 * provider-launched work without cancelling the caller's scope.
 */
interface PhoneBridgeProvider {

    /** Current provider availability. */
    val status: StateFlow<PhoneBridgeProviderStatus>

    /** Validated bridge events in arrival order. */
    val events: SharedFlow<PhoneBridgeEvent>

    /** Asks the phone to approve pairing (opens a pair.request). */
    suspend fun requestPairing(): PhoneBridgeSendResult

    /** Asks the phone to capture (requires an active session). */
    suspend fun requestCapture(preference: CapturePreference = CapturePreference.AUTO): PhoneBridgeSendResult

    /** Saves a result on the phone (ack arrives as result.update). */
    suspend fun saveResult(resultId: String, productTitle: String? = null): PhoneBridgeSendResult

    /** Opens a result on the phone. */
    suspend fun openOnPhone(resultId: String): PhoneBridgeSendResult

    /** Retries a failed or stale scan. */
    suspend fun retryScan(scanId: String): PhoneBridgeSendResult

    /** Cancels an in-flight scan. */
    suspend fun cancelScan(scanId: String): PhoneBridgeSendResult

    /** Closes the provider and cancels all provider-launched coroutines. */
    fun close()
}
