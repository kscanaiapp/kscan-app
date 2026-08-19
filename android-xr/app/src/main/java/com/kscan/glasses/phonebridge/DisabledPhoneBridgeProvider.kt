package com.kscan.glasses.phonebridge

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Controlled OFF state: the bridge is explicitly disabled by configuration.
 *
 * Fails safe — every call returns [PhoneBridgeSendResult.Disabled] and no
 * frame is ever sent. Never throws, never crashes the UI.
 */
class DisabledPhoneBridgeProvider : PhoneBridgeProvider {

    private val _status = MutableStateFlow(PhoneBridgeProviderStatus.DISABLED)
    override val status: StateFlow<PhoneBridgeProviderStatus> = _status.asStateFlow()

    private val _events = MutableSharedFlow<PhoneBridgeEvent>(extraBufferCapacity = 1)
    override val events: SharedFlow<PhoneBridgeEvent> = _events.asSharedFlow()

    private val _pairingCode = MutableStateFlow<String?>(null)
    override val pairingCode: StateFlow<String?> = _pairingCode.asStateFlow()

    private val _diagnostics = MutableStateFlow<List<Pair<String, String>>>(emptyList())
    override val diagnostics: StateFlow<List<Pair<String, String>>> = _diagnostics.asStateFlow()

    override suspend fun requestPairing(): PhoneBridgeSendResult = PhoneBridgeSendResult.Disabled
    override suspend fun requestCapture(preference: CapturePreference): PhoneBridgeSendResult =
        PhoneBridgeSendResult.Disabled
    override suspend fun saveResult(resultId: String, productTitle: String?): PhoneBridgeSendResult =
        PhoneBridgeSendResult.Disabled
    override suspend fun openOnPhone(resultId: String): PhoneBridgeSendResult = PhoneBridgeSendResult.Disabled
    override suspend fun retryScan(scanId: String): PhoneBridgeSendResult = PhoneBridgeSendResult.Disabled
    override suspend fun cancelScan(scanId: String): PhoneBridgeSendResult = PhoneBridgeSendResult.Disabled

    override fun close() = Unit
}
