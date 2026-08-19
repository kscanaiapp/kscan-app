package com.kscan.glasses.phonebridge

import com.kscan.glasses.config.SafeLog
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Real result-only provider backed by the authenticated wearable Edge Function. */
class RealKScanPhoneBridgeProvider(
    private val api: WearableBridgeApi,
    private val glassesDeviceId: String,
    private val appVersion: String,
    parentScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    private val clock: () -> Long = System::currentTimeMillis,
    private val pollIntervalMs: Long = 1_000,
) : PhoneBridgeProvider {
    private val job: Job = SupervisorJob(parentScope.coroutineContext[Job])
    private val scope = CoroutineScope(parentScope.coroutineContext + job)
    private val validator = PhoneBridgeValidator(glassesDeviceId, clock)

    private val _status = MutableStateFlow(PhoneBridgeProviderStatus.ACTIVE)
    override val status: StateFlow<PhoneBridgeProviderStatus> = _status.asStateFlow()
    private val _events = MutableSharedFlow<PhoneBridgeEvent>(extraBufferCapacity = 64)
    override val events: SharedFlow<PhoneBridgeEvent> = _events.asSharedFlow()
    private val _pairingCode = MutableStateFlow<String?>(null)
    override val pairingCode: StateFlow<String?> = _pairingCode.asStateFlow()

    private var pollJob: Job? = null
    private var wearableToken: String? = null
    private var cursor: Long = 0

    override suspend fun requestPairing(): PhoneBridgeSendResult {
        if (!job.isActive) return PhoneBridgeSendResult.Unavailable
        pollJob?.cancel()
        wearableToken = null
        cursor = 0
        val now = clock()
        val request = PhoneBridgeMessage.PairRequest(
            requestId = nextId(),
            deviceId = glassesDeviceId,
            timestamp = now,
            expiresAt = now + PAIRING_TTL_MS,
            payload = PairRequestPayload(model = GLASSES_MODEL, appVersion = appVersion),
        )
        return try {
            val frame = validator.validateOutgoing(request)
            val ticket = api.createPairing(frame)
            _pairingCode.value = ticket.challengeCode
            startPairPolling(ticket)
            PhoneBridgeSendResult.Sent
        } catch (_: Exception) {
            _status.value = PhoneBridgeProviderStatus.UNAVAILABLE
            PhoneBridgeSendResult.Unavailable
        }
    }

    override suspend fun requestCapture(preference: CapturePreference): PhoneBridgeSendResult =
        sendSession { sessionId, now ->
            PhoneBridgeMessage.CaptureRequest(
                requestId = nextId(), sessionId = sessionId, deviceId = glassesDeviceId,
                timestamp = now, expiresAt = now + ACTION_TTL_MS,
                payload = CaptureRequestPayload(preference),
            )
        }

    override suspend fun saveResult(resultId: String, productTitle: String?): PhoneBridgeSendResult =
        sendSession { sessionId, now ->
            PhoneBridgeMessage.ActionSave(
                requestId = nextId(), sessionId = sessionId, deviceId = glassesDeviceId,
                timestamp = now, expiresAt = now + ACTION_TTL_MS,
                payload = ActionSavePayload(resultId, productTitle),
            )
        }

    override suspend fun openOnPhone(resultId: String): PhoneBridgeSendResult =
        sendSession { sessionId, now ->
            PhoneBridgeMessage.ActionOpenOnPhone(
                requestId = nextId(), sessionId = sessionId, deviceId = glassesDeviceId,
                timestamp = now, expiresAt = now + ACTION_TTL_MS,
                payload = ActionOpenOnPhonePayload(resultId),
            )
        }

    override suspend fun retryScan(scanId: String): PhoneBridgeSendResult =
        sendSession { sessionId, now ->
            PhoneBridgeMessage.ActionRetry(
                requestId = nextId(), sessionId = sessionId, deviceId = glassesDeviceId,
                timestamp = now, expiresAt = now + ACTION_TTL_MS,
                payload = ActionRetryPayload(scanId),
            )
        }

    override suspend fun cancelScan(scanId: String): PhoneBridgeSendResult =
        sendSession { sessionId, now ->
            PhoneBridgeMessage.ActionCancel(
                requestId = nextId(), sessionId = sessionId, deviceId = glassesDeviceId,
                timestamp = now, expiresAt = now + ACTION_TTL_MS,
                payload = ActionCancelPayload(scanId),
            )
        }

    override fun close() {
        wearableToken = null
        _pairingCode.value = null
        job.cancel()
    }

    private fun startPairPolling(ticket: PairingTicket) {
        pollJob = scope.launch {
            while (isActive && clock() < ticket.expiresAt && wearableToken == null) {
                try {
                    val poll = api.pollPairing(ticket.pairingHandle, ticket.pairingSecret, cursor)
                    cursor = maxOf(cursor, poll.cursor)
                    acceptFrames(poll.frames)
                    poll.wearableToken?.let {
                        wearableToken = it
                        _pairingCode.value = null
                        _status.value = PhoneBridgeProviderStatus.ACTIVE
                        startSessionPolling()
                        return@launch
                    }
                } catch (_: Exception) {
                    SafeLog.w(TAG, "pair_poll_failed")
                }
                delay(pollIntervalMs)
            }
            if (wearableToken == null && isActive) {
                _pairingCode.value = null
                _events.emit(PhoneBridgeEvent.PairExpired)
            }
        }
    }

    private fun startSessionPolling() {
        pollJob = scope.launch {
            var consecutiveFailures = 0
            var reportedLost = false
            while (isActive && wearableToken != null) {
                try {
                    val poll = api.poll(wearableToken!!, cursor)
                    cursor = maxOf(cursor, poll.cursor)
                    acceptFrames(poll.frames)
                    consecutiveFailures = 0
                    if (reportedLost) {
                        reportedLost = false
                        _status.value = PhoneBridgeProviderStatus.ACTIVE
                        _events.emit(PhoneBridgeEvent.ConnectionRestored)
                    }
                } catch (_: Exception) {
                    consecutiveFailures += 1
                    if (consecutiveFailures >= FAILURE_THRESHOLD && !reportedLost) {
                        reportedLost = true
                        _status.value = PhoneBridgeProviderStatus.UNAVAILABLE
                        _events.emit(PhoneBridgeEvent.ConnectionLost(ConnectionLostReason.TRANSPORT_LOST))
                    }
                }
                delay(pollIntervalMs)
            }
        }
    }

    private suspend fun acceptFrames(frames: List<String>) {
        for (raw in frames) {
            val accepted = validator.validateIncoming(raw) as? PhoneBridgeValidator.ValidationResult.Accepted
                ?: continue
            val event = accepted.message.toEvent() ?: continue
            if (event is PhoneBridgeEvent.SessionRevoked) wearableToken = null
            _events.emit(event)
        }
    }

    private suspend fun sendSession(build: (String, Long) -> PhoneBridgeMessage): PhoneBridgeSendResult {
        val token = wearableToken ?: return PhoneBridgeSendResult.Unavailable
        val sessionId = validator.currentSessionId ?: return PhoneBridgeSendResult.Unavailable
        if (validator.sessionRevoked || (validator.sessionExpiresAt ?: 0) <= clock()) {
            wearableToken = null
            return PhoneBridgeSendResult.Unavailable
        }
        return try {
            api.send(token, validator.validateOutgoing(build(sessionId, clock())))
            PhoneBridgeSendResult.Sent
        } catch (_: Exception) {
            PhoneBridgeSendResult.Unavailable
        }
    }

    private fun nextId(): String = UUID.randomUUID().toString()

    companion object {
        private const val TAG = "RealPhoneBridge"
        private const val GLASSES_MODEL = "K Scan Google XR"
        private const val PAIRING_TTL_MS = 2 * 60 * 1_000L
        private const val ACTION_TTL_MS = 30_000L
        private const val FAILURE_THRESHOLD = 3
    }
}
