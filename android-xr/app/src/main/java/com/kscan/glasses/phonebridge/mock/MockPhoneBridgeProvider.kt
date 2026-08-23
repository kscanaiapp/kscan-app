package com.kscan.glasses.phonebridge.mock

import com.kscan.glasses.phonebridge.ActionCancelPayload
import com.kscan.glasses.phonebridge.ActionOpenOnPhonePayload
import com.kscan.glasses.phonebridge.ActionRetryPayload
import com.kscan.glasses.phonebridge.ActionSavePayload
import com.kscan.glasses.phonebridge.CapturePreference
import com.kscan.glasses.phonebridge.CaptureRequestPayload
import com.kscan.glasses.phonebridge.InMemoryTransportPair
import com.kscan.glasses.phonebridge.PairRequestPayload
import com.kscan.glasses.phonebridge.PhoneBridgeEvent
import com.kscan.glasses.phonebridge.PhoneBridgeMessage
import com.kscan.glasses.phonebridge.PhoneBridgeProvider
import com.kscan.glasses.phonebridge.PhoneBridgeProviderStatus
import com.kscan.glasses.phonebridge.PhoneBridgeSendResult
import com.kscan.glasses.phonebridge.PhoneBridgeValidator
import com.kscan.glasses.phonebridge.toEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Mock phone-bridge provider: the versioned protocol end-to-end in memory.
 *
 * DEBUG-ONLY. Selected by AppRuntimeFactory solely when the build is debug AND
 * BuildConfig.KSCAN_DEBUG_MOCK_PHONE_BRIDGE=true. Release wiring never selects
 * this class, and ReleaseSafetyGuard.verifyDependencies rejects its instance
 * in any release or flag-mismatched configuration.
 *
 * Both directions flow through the real raw-frame transport: outbound frames
 * are encoded and validated (registering correlation state), cross the
 * in-memory channel to the [MockPhoneCompanion], and its replies are validated
 * on the way back before becoming [PhoneBridgeEvent]s.
 *
 * Structured concurrency: all collector coroutines are children of an internal
 * supervisor job parented to the supplied scope. [close] cancels exactly that
 * job and closes the transports — it never cancels the caller's scope.
 */
class MockPhoneBridgeProvider private constructor(
    private val transports: InMemoryTransportPair,
    private val validator: PhoneBridgeValidator,
    parentScope: CoroutineScope,
    private val glassesDeviceId: String,
    private val appVersion: String,
    private val clock: () -> Long,
    internal val companion: MockPhoneCompanion,
) : PhoneBridgeProvider {

    private val job: Job = SupervisorJob(parentScope.coroutineContext[Job])
    private val scope: CoroutineScope = CoroutineScope(parentScope.coroutineContext + job)

    private val _status = MutableStateFlow(PhoneBridgeProviderStatus.ACTIVE)
    override val status: StateFlow<PhoneBridgeProviderStatus> = _status.asStateFlow()

    private val _events = MutableSharedFlow<PhoneBridgeEvent>(extraBufferCapacity = EVENT_BUFFER)
    override val events: SharedFlow<PhoneBridgeEvent> = _events.asSharedFlow()

    private val _pairingCode = MutableStateFlow<String?>(null)
    override val pairingCode: StateFlow<String?> = _pairingCode.asStateFlow()

    private val _diagnostics = MutableStateFlow<List<Pair<String, String>>>(emptyList())
    override val diagnostics: StateFlow<List<Pair<String, String>>> = _diagnostics.asStateFlow()

    private var idCounter = 0
    private fun nextId(): String = "glasses-req-${++idCounter}"

    init {
        scope.launch {
            transports.glassesSide.incoming.collect { raw ->
                val accepted = validator.validateIncoming(raw) as? PhoneBridgeValidator.ValidationResult.Accepted
                    ?: return@collect
                val event = accepted.message.toEvent() ?: return@collect
                when (event) {
                    is PhoneBridgeEvent.ConnectionLost -> _status.value = PhoneBridgeProviderStatus.UNAVAILABLE
                    is PhoneBridgeEvent.ConnectionRestored -> _status.value = PhoneBridgeProviderStatus.ACTIVE
                    else -> Unit
                }
                _events.emit(event)
            }
        }
        scope.launch {
            transports.phoneSide.incoming.collect { raw -> companion.handleIncoming(raw) }
        }
    }

    override suspend fun requestPairing(): PhoneBridgeSendResult {
        if (!job.isActive) return PhoneBridgeSendResult.Unavailable
        return send(
            PhoneBridgeMessage.PairRequest(
                requestId = nextId(),
                deviceId = glassesDeviceId,
                timestamp = clock(),
                payload = PairRequestPayload(model = GLASSES_MODEL, appVersion = appVersion),
            ),
        )
    }

    override suspend fun requestCapture(preference: CapturePreference): PhoneBridgeSendResult {
        val sessionId = activeSession() ?: return PhoneBridgeSendResult.Unavailable
        return send(
            PhoneBridgeMessage.CaptureRequest(
                requestId = nextId(),
                sessionId = sessionId,
                deviceId = glassesDeviceId,
                timestamp = clock(),
                payload = CaptureRequestPayload(preference = preference),
            ),
        )
    }

    override suspend fun saveResult(resultId: String, productTitle: String?): PhoneBridgeSendResult {
        val sessionId = activeSession() ?: return PhoneBridgeSendResult.Unavailable
        return send(
            PhoneBridgeMessage.ActionSave(
                requestId = nextId(),
                sessionId = sessionId,
                deviceId = glassesDeviceId,
                timestamp = clock(),
                payload = ActionSavePayload(resultId = resultId, productTitle = productTitle, actionId = "save:$resultId"),
            ),
        )
    }

    override suspend fun openOnPhone(resultId: String): PhoneBridgeSendResult {
        val sessionId = activeSession() ?: return PhoneBridgeSendResult.Unavailable
        return send(
            PhoneBridgeMessage.ActionOpenOnPhone(
                requestId = nextId(),
                sessionId = sessionId,
                deviceId = glassesDeviceId,
                timestamp = clock(),
                payload = ActionOpenOnPhonePayload(resultId = resultId, actionId = "open:$resultId"),
            ),
        )
    }

    override suspend fun retryScan(scanId: String): PhoneBridgeSendResult {
        val sessionId = activeSession() ?: return PhoneBridgeSendResult.Unavailable
        return send(
            PhoneBridgeMessage.ActionRetry(
                requestId = nextId(),
                sessionId = sessionId,
                deviceId = glassesDeviceId,
                timestamp = clock(),
                payload = ActionRetryPayload(scanId = scanId),
            ),
        )
    }

    override suspend fun cancelScan(scanId: String): PhoneBridgeSendResult {
        val sessionId = activeSession() ?: return PhoneBridgeSendResult.Unavailable
        return send(
            PhoneBridgeMessage.ActionCancel(
                requestId = nextId(),
                sessionId = sessionId,
                deviceId = glassesDeviceId,
                timestamp = clock(),
                payload = ActionCancelPayload(scanId = scanId),
            ),
        )
    }

    override fun close() {
        job.cancel()
        transports.glassesSide.close()
        transports.phoneSide.close()
    }

    private fun activeSession(): String? =
        if (job.isActive) validator.currentSessionId else null

    private suspend fun send(message: PhoneBridgeMessage): PhoneBridgeSendResult {
        val frame = validator.validateOutgoing(message)
        transports.glassesSide.send(frame)
        return PhoneBridgeSendResult.Sent
    }

    companion object {
        private const val EVENT_BUFFER = 64
        private const val GLASSES_MODEL = "KScan Glasses"

        fun create(
            parentScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
            clock: () -> Long = System::currentTimeMillis,
            glassesDeviceId: String = "glasses-1",
            phoneDeviceId: String = MockPhoneCompanion.DEFAULT_DEVICE_ID,
            pairBehavior: MockPhoneCompanion.PairBehavior = MockPhoneCompanion.PairBehavior.APPROVE,
            appVersion: String = "0.1.0-alpha",
        ): MockPhoneBridgeProvider {
            val transports = InMemoryTransportPair()
            return MockPhoneBridgeProvider(
                transports = transports,
                validator = PhoneBridgeValidator(glassesDeviceId, clock),
                parentScope = parentScope,
                glassesDeviceId = glassesDeviceId,
                appVersion = appVersion,
                clock = clock,
                companion = MockPhoneCompanion(
                    transport = transports.phoneSide,
                    clock = clock,
                    deviceId = phoneDeviceId,
                    pairBehavior = pairBehavior,
                ),
            )
        }
    }
}
