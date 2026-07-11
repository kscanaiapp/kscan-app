package expo.modules.kscanpiinative

import android.os.Bundle
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

enum class NativePrivacyStatus(val value: String) {
    SUCCESS("success"),
    NO_FACES("no_faces"),
    UNSUPPORTED("unsupported"),
    FAILED("failed");

    companion object {
        fun from(value: String): NativePrivacyStatus? = entries.find { it.value == value }
    }
}

enum class NativePrivacyErrorCode(val value: String) {
    INVALID_INPUT("INVALID_INPUT"),
    INVALID_URI("INVALID_URI"),
    UNSUPPORTED_SCHEME("UNSUPPORTED_SCHEME"),
    UNSUPPORTED_FORMAT("UNSUPPORTED_FORMAT"),
    IMAGE_TOO_LARGE("IMAGE_TOO_LARGE"),
    DECODE_FAILED("DECODE_FAILED"),
    ORIENTATION_FAILED("ORIENTATION_FAILED"),
    DETECTOR_UNAVAILABLE("DETECTOR_UNAVAILABLE"),
    DETECTION_FAILED("DETECTION_FAILED"),
    INVALID_REGION("INVALID_REGION"),
    MASKING_FAILED("MASKING_FAILED"),
    ENCODING_FAILED("ENCODING_FAILED"),
    VERIFICATION_FAILED("VERIFICATION_FAILED"),
    CLEANUP_REJECTED("CLEANUP_REJECTED"),
    CLEANUP_FAILED("CLEANUP_FAILED"),
    INTERNAL_ERROR("INTERNAL_ERROR");

    companion object {
        fun from(value: String): NativePrivacyErrorCode? = entries.find { it.value == value }
    }
}

data class NativeFaceMaskInputRecord(
    @Field val imageUri: String = "",
    @Field val paddingRatio: Double? = null,
) : Record

data class NativeFaceMaskInput(
    val imageUri: String,
    val paddingRatio: Double = NativePrivacyConstants.DEFAULT_PADDING_RATIO,
)

data class NativeFaceRegion(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
)

data class NativeFaceMaskResult(
    val status: NativePrivacyStatus,
    val platform: String,
    val detectorImplementation: String,
    val detectorVersion: String,
    val sanitizerVersion: String,
    val inputWidth: Int? = null,
    val inputHeight: Int? = null,
    val outputWidth: Int? = null,
    val outputHeight: Int? = null,
    val facesDetected: Int,
    val facesAccepted: Int,
    val facesMasked: Int,
    val regionsChanged: Int,
    val regionsAlreadyRedacted: Int,
    val pixelsChanged: Boolean,
    val sanitizedUri: String? = null,
    val inputChecksum: String? = null,
    val outputChecksum: String? = null,
    val checksumAlgorithm: String? = null,
    val detectionDurationMs: Long? = null,
    val maskingDurationMs: Long? = null,
    val encodingDurationMs: Long? = null,
    val verificationDurationMs: Long? = null,
    val totalDurationMs: Long? = null,
    val warnings: List<String> = emptyList(),
    val errorCode: NativePrivacyErrorCode? = null,
    val failureReason: String? = null,
) {
    fun toBundle(): Bundle = Bundle().apply {
        putString("status", status.value)
        putString("platform", platform)
        putString("detectorImplementation", detectorImplementation)
        putString("detectorVersion", detectorVersion)
        putString("sanitizerVersion", sanitizerVersion)
        inputWidth?.let { putInt("inputWidth", it) }
        inputHeight?.let { putInt("inputHeight", it) }
        outputWidth?.let { putInt("outputWidth", it) }
        outputHeight?.let { putInt("outputHeight", it) }
        putInt("facesDetected", facesDetected)
        putInt("facesAccepted", facesAccepted)
        putInt("facesMasked", facesMasked)
        putInt("regionsChanged", regionsChanged)
        putInt("regionsAlreadyRedacted", regionsAlreadyRedacted)
        putBoolean("pixelsChanged", pixelsChanged)
        sanitizedUri?.let { putString("sanitizedUri", it) }
        inputChecksum?.let { putString("inputChecksum", it) }
        outputChecksum?.let { putString("outputChecksum", it) }
        checksumAlgorithm?.let { putString("checksumAlgorithm", it) }
        detectionDurationMs?.let { putLong("detectionDurationMs", it) }
        maskingDurationMs?.let { putLong("maskingDurationMs", it) }
        encodingDurationMs?.let { putLong("encodingDurationMs", it) }
        verificationDurationMs?.let { putLong("verificationDurationMs", it) }
        totalDurationMs?.let { putLong("totalDurationMs", it) }
        putStringArray("warnings", warnings.toTypedArray())
        errorCode?.let { putString("errorCode", it.value) }
        failureReason?.let { putString("failureReason", it) }
    }
}

data class NativePrivacyCapabilities(
    val supported: Boolean,
    val platform: String,
    val detectorImplementation: String,
    val acceptedUriSchemes: List<String>,
    val acceptedMimeTypes: List<String>,
    val outputMimeType: String,
    val maxWidth: Int,
    val maxHeight: Int,
    val maxPixels: Long,
    val sanitizerVersion: String,
) {
    fun toBundle(): Bundle = Bundle().apply {
        putBoolean("supported", supported)
        putString("platform", platform)
        putString("detectorImplementation", detectorImplementation)
        putStringArray("acceptedUriSchemes", acceptedUriSchemes.toTypedArray())
        putStringArray("acceptedMimeTypes", acceptedMimeTypes.toTypedArray())
        putString("outputMimeType", outputMimeType)
        putInt("maxWidth", maxWidth)
        putInt("maxHeight", maxHeight)
        putLong("maxPixels", maxPixels)
        putString("sanitizerVersion", sanitizerVersion)
    }
}

data class NativeCleanupResult(
    val deleted: Boolean,
    val rejected: Boolean,
    val warnings: List<String> = emptyList(),
) {
    fun toBundle(): Bundle = Bundle().apply {
        putBoolean("deleted", deleted)
        putBoolean("rejected", rejected)
        putStringArray("warnings", warnings.toTypedArray())
    }
}
