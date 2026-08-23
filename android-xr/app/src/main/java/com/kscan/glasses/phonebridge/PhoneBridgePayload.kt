package com.kscan.glasses.phonebridge

import com.kscan.glasses.scan.ScanErrorCode
import kotlinx.serialization.Serializable

/** Marker supertype for all phone-bridge message payloads. */
@Serializable
sealed interface PhoneBridgePayload

/** Empty body for messages that carry envelope data only. Serializes as {}. */
@Serializable
object EmptyPayload : PhoneBridgePayload

// ----- pair.* payloads -----

@Serializable
data class PairRequestPayload(
    val model: String,
    val appVersion: String,
) : PhoneBridgePayload

@Serializable
data class PairApprovedPayload(
    /** Absolute wall-clock millis at which the granted session expires. */
    val sessionExpiresAt: Long,
) : PhoneBridgePayload

@Serializable
data class PairDeniedPayload(
    val reason: PairDenyReason,
) : PhoneBridgePayload

// ----- session.* payloads -----

@Serializable
data class SessionReadyPayload(
    val phoneAppVersion: String,
    val features: List<String> = emptyList(),
) : PhoneBridgePayload

@Serializable
data class SessionRevokedPayload(
    val reason: SessionRevokeReason,
) : PhoneBridgePayload

@Serializable
data class SessionErrorPayload(
    /** Safe, user-presentable error code string (e.g. a ScanErrorCode name). */
    val code: String,
    val recoverable: Boolean,
) : PhoneBridgePayload

// ----- capture.* payloads -----

@Serializable
data class CaptureRequestPayload(
    val preference: CapturePreference,
) : PhoneBridgePayload

@Serializable
data class CaptureStartedPayload(
    val captureId: String,
) : PhoneBridgePayload

@Serializable
data class CaptureCompletedPayload(
    val captureId: String,
    /** Opaque reference the phone uses to locate the capture. Never image data. */
    val captureRef: String,
) : PhoneBridgePayload

@Serializable
data class CaptureFailedPayload(
    val captureId: String,
    val code: ScanErrorCode,
) : PhoneBridgePayload

// ----- scan.* payloads -----

@Serializable
data class ScanProcessingPayload(
    val scanId: String,
) : PhoneBridgePayload

@Serializable
data class ScanProgressPayload(
    val scanId: String,
    val stage: ScanStage,
    val percent: Int,
) : PhoneBridgePayload

@Serializable
data class ScanCompletedPayload(
    val scanId: String,
    val resultId: String,
) : PhoneBridgePayload

@Serializable
data class ScanFailedPayload(
    val scanId: String,
    val code: ScanErrorCode,
) : PhoneBridgePayload

// ----- result.* payloads -----

@Serializable
data class ResultProduct(
    val title: String,
    val brand: String,
    val price: String,
    val currency: String,
    val group: RetailGroup,
    /** HTTPS thumbnail URL only; no data URIs, no token-bearing query strings. */
    val thumbnailUrl: String? = null,
) : PhoneBridgePayload

@Serializable
data class ResultPayload(
    val resultId: String,
    val summary: String,
    val confidence: Float,
    val products: List<ResultProduct> = emptyList(),
    val availableActions: List<ResultAction> = emptyList(),
    val scanStatus: ScanStatus,
    val errorCode: ScanErrorCode? = null,
) : PhoneBridgePayload

@Serializable
data class ResultShowPayload(
    val result: ResultPayload,
) : PhoneBridgePayload

@Serializable
data class ResultUpdatePayload(
    val result: ResultPayload,
    val revision: Int,
) : PhoneBridgePayload

@Serializable
data class ResultDismissPayload(
    val resultId: String,
) : PhoneBridgePayload

// ----- action.* payloads -----

@Serializable
data class ActionSavePayload(
    val resultId: String,
    val productTitle: String? = null,
    /** Stable idempotency key for the same logical user action (save of a given result). */
    val actionId: String,
) : PhoneBridgePayload

@Serializable
data class ActionOpenOnPhonePayload(
    val resultId: String,
    /** Stable idempotency key for the same logical user action (open of a given result). */
    val actionId: String,
) : PhoneBridgePayload

@Serializable
data class ActionRetryPayload(
    val scanId: String,
) : PhoneBridgePayload

@Serializable
data class ActionCancelPayload(
    val scanId: String,
) : PhoneBridgePayload

// ----- connection.* payloads -----

@Serializable
data class ConnectionPingPayload(
    val nonce: String,
) : PhoneBridgePayload

@Serializable
data class ConnectionPongPayload(
    val nonce: String,
) : PhoneBridgePayload

@Serializable
data class ConnectionLostPayload(
    val reason: ConnectionLostReason,
) : PhoneBridgePayload
