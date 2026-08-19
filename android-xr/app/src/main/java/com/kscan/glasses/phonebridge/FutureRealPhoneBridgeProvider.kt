package com.kscan.glasses.phonebridge

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Explicit stub for the future REAL phone transport.
 *
 * This is NOT a silent mock: it never fabricates events and never pretends a
 * session exists. Every call reports [PhoneBridgeSendResult.Unavailable] so
 * the UI renders a controlled "bridge unavailable" state. When the real
 * transport lands, this class is replaced by it at the single composition
 * point (AppRuntimeFactory).
 */
class FutureRealPhoneBridgeProvider : PhoneBridgeProvider {

    private val _status = MutableStateFlow(PhoneBridgeProviderStatus.UNAVAILABLE)
    override val status: StateFlow<PhoneBridgeProviderStatus> = _status.asStateFlow()

    private val _events = MutableSharedFlow<PhoneBridgeEvent>(extraBufferCapacity = 1)
    override val events: SharedFlow<PhoneBridgeEvent> = _events.asSharedFlow()

    private val _pairingCode = MutableStateFlow<String?>(null)
    override val pairingCode: StateFlow<String?> = _pairingCode.asStateFlow()

    private val _diagnostics = MutableStateFlow<List<Pair<String, String>>>(emptyList())
    override val diagnostics: StateFlow<List<Pair<String, String>>> = _diagnostics.asStateFlow()

    override suspend fun requestPairing(): PhoneBridgeSendResult = PhoneBridgeSendResult.Unavailable
    override suspend fun requestCapture(preference: CapturePreference): PhoneBridgeSendResult =
        PhoneBridgeSendResult.Unavailable
    override suspend fun saveResult(resultId: String, productTitle: String?): PhoneBridgeSendResult =
        PhoneBridgeSendResult.Unavailable
    override suspend fun openOnPhone(resultId: String): PhoneBridgeSendResult = PhoneBridgeSendResult.Unavailable
    override suspend fun retryScan(scanId: String): PhoneBridgeSendResult = PhoneBridgeSendResult.Unavailable
    override suspend fun cancelScan(scanId: String): PhoneBridgeSendResult = PhoneBridgeSendResult.Unavailable

    override fun close() = Unit
}
