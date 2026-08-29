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

// ── License-plate masking (Build 34, closet media privacy) ───────────────────
//
// The SECOND question the same pipeline can be asked. It shares the decoder,
// the box normalizer, the redactor, the cache manager and the output verifier
// with face masking; it differs only in which regions it selects.
//
// WHAT IS DELIBERATELY ABSENT FROM THESE MODELS: any field that could carry a
// recognized character across the bridge. There is no `text`, no `plateNumber`,
// no `sample`, no `preview`. That absence is the privacy contract, not an
// oversight — a field would eventually be filled. Counts and geometry only.

/** Mirrors NativeFaceMaskInputRecord exactly; the padding contract is shared. */
data class NativePlateMaskInputRecord(
    @Field val imageUri: String = "",
    @Field val paddingRatio: Double? = null,
) : Record

/**
 * A SEPARATE status vocabulary from NativePrivacyStatus, matching the split the
 * TypeScript contract makes (NativePlateStatus vs NativePrivacyStatus).
 *
 * The alternative — adding NO_PLATES to the shared face enum — would put a
 * value in the face path's type that the face path can never emit, and would
 * edit a vocabulary the face path already ships with. Two small enums are
 * cheaper than one enum that is a lie about one of its users.
 *
 * NO_PLATES means "the image was screened and nothing plate-shaped matched",
 * which is NOT a masked-success value: no sanitized output is produced with it.
 */
enum class NativePlateStatus(val value: String) {
    SUCCESS("success"),
    NO_PLATES("no_plates"),
    UNSUPPORTED("unsupported"),
    FAILED("failed");

    companion object {
        fun from(value: String): NativePlateStatus? = entries.find { it.value == value }
    }
}

data class NativePlateMaskResult(
    val status: NativePlateStatus,
    val platform: String,
    val detectorImplementation: String,
    val detectorVersion: String,
    val sanitizerVersion: String,
    val inputWidth: Int? = null,
    val inputHeight: Int? = null,
    val outputWidth: Int? = null,
    val outputHeight: Int? = null,
    val platesDetected: Int,
    val platesAccepted: Int,
    val platesMasked: Int,
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
        putInt("platesDetected", platesDetected)
        putInt("platesAccepted", platesAccepted)
        putInt("platesMasked", platesMasked)
        putInt("regionsChanged", regionsChanged)
        putInt("regionsAlreadyRedacted", regionsAlreadyRedacted)
        putBoolean("pixelsChanged", pixelsChanged)
        // Present ONLY on a verified masked output. Every failure path leaves
        // it absent, so a consumer that reads this field can never be handed
        // the original image believing it was sanitized.
        sanitizedUri?.let { putString("sanitizedUri", it) }
        // Written as a LITERAL, not a constructor field, so no present or
        // future code path in this module can set it true without also
        // changing this line and the audit that reads it.
        putBoolean("ocrPerformed", false)
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

/**
 * The first five fields are the shared cross-platform contract. The geometry
 * block below them is Android-specific reporting, and is here so a caller can
 * record WHICH heuristic screened a given image: a threshold change then shows
 * up in the telemetry of the build that shipped it instead of being an
 * invisible behaviour change.
 *
 * The decoder limits (accepted schemes, MIME types, max dimensions) are NOT
 * repeated here. Plate masking uses the same decoder as face masking, so
 * getPrivacyCapabilities already answers for both, and a second copy is a
 * second thing to drift.
 */
data class NativePlateCapabilities(
    val supported: Boolean,
    val platform: String,
    val detectorImplementation: String,
    val detectorVersion: String,
    val sanitizerVersion: String,
    val defaultPaddingRatio: Double,
    val minAspectRatio: Double,
    val maxAspectRatio: Double,
    val minWidthRatio: Double,
    val minHeightPx: Int,
    val minAreaRatio: Double,
) {
    fun toBundle(): Bundle = Bundle().apply {
        putBoolean("supported", supported)
        putString("platform", platform)
        putString("detectorImplementation", detectorImplementation)
        putString("detectorVersion", detectorVersion)
        putString("sanitizerVersion", sanitizerVersion)
        putDouble("defaultPaddingRatio", defaultPaddingRatio)
        putDouble("minAspectRatio", minAspectRatio)
        putDouble("maxAspectRatio", maxAspectRatio)
        putDouble("minWidthRatio", minWidthRatio)
        putInt("minHeightPx", minHeightPx)
        putDouble("minAreaRatio", minAreaRatio)
        // Literal, not a field: the contract's auditable claim that no
        // character recognition is performed on any path. Nothing in this
        // module can set it true without editing this line.
        putBoolean("ocrPerformed", false)
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
