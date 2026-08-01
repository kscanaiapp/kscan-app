package expo.modules.kscanpiinative

import android.os.Bundle
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * Wire models for person / body-region detection (Build 2.5 Step 3).
 *
 * Every coordinate that crosses the bridge is NORMALIZED to 0..1. Pixels are
 * never sent: detection runs on a bounded inference image and the caller crops
 * from a larger normalized source, so a pixel value would be measured against
 * the wrong picture. Normalizing here also means the bridge carries nothing
 * that could be mistaken for a dimension precise enough to fingerprint a source.
 */

/** Matches NativeFaceMaskInputRecord's shape; one field, no options. */
data class NativePersonDetectionInputRecord(
    @Field val imageUri: String = "",
) : Record

data class NormalizedRect(
    val x: Float,
    val y: Float,
    val width: Float,
    val height: Float,
) {
    fun toBundle(): Bundle = Bundle().apply {
        putDouble("x", x.toDouble())
        putDouble("y", y.toDouble())
        putDouble("width", width.toDouble())
        putDouble("height", height.toDouble())
    }

    companion object {
        /** Build from pixel edges, clamped into the unit square. */
        fun fromPixels(
            left: Float,
            top: Float,
            right: Float,
            bottom: Float,
            imageWidth: Int,
            imageHeight: Int,
        ): NormalizedRect? {
            if (imageWidth <= 0 || imageHeight <= 0) return null
            val x0 = (left / imageWidth).coerceIn(0f, 1f)
            val y0 = (top / imageHeight).coerceIn(0f, 1f)
            val x1 = (right / imageWidth).coerceIn(0f, 1f)
            val y1 = (bottom / imageHeight).coerceIn(0f, 1f)
            val w = x1 - x0
            val h = y1 - y0
            if (w <= 0f || h <= 0f) return null
            return NormalizedRect(x0, y0, w, h)
        }
    }
}

data class BodyLandmark(
    val type: BodyLandmarkType,
    val x: Float,
    val y: Float,
    val confidence: Float,
) {
    fun toBundle(): Bundle = Bundle().apply {
        putString("type", type.wireName)
        putDouble("x", x.toDouble())
        putDouble("y", y.toDouble())
        putDouble("confidence", confidence.toDouble())
    }
}

data class DetectedPerson(
    val bounds: NormalizedRect,
    val rankingExtent: NormalizedRect,
    val confidence: Float,
    val landmarks: List<BodyLandmark>,
) {
    fun toBundle(): Bundle = Bundle().apply {
        putBundle("bounds", bounds.toBundle())
        putBundle("rankingExtent", rankingExtent.toBundle())
        putDouble("confidence", confidence.toDouble())
        putParcelableArrayList("landmarks", ArrayList(landmarks.map { it.toBundle() }))
        // `maskCoverage` is deliberately ABSENT, not zero. ML Kit pose
        // detection produces no segmentation mask, and zero would read as "the
        // mask says this box is empty" — which would demote every Android
        // region to `review` and break parity with iOS in the wrong direction.
        // The adapter maps an absent value to null, which is neutral.
    }
}

enum class NativeExtractionStatus(val wireName: String) {
    SUCCESS("success"),
    NO_PERSON("no_person"),
    UNSUPPORTED("unsupported"),
    FAILED("failed"),
}

data class NativePersonDetectionResult(
    val status: NativeExtractionStatus,
    val persons: List<DetectedPerson> = emptyList(),
    val inputWidth: Int? = null,
    val inputHeight: Int? = null,
    val detectionDurationMs: Long? = null,
    val totalDurationMs: Long? = null,
    val warnings: List<String> = emptyList(),
    val errorCode: NativePrivacyErrorCode? = null,
    val failureReason: String? = null,
) {
    fun toBundle(): Bundle = Bundle().apply {
        putString("status", status.wireName)
        putString("platform", "android")
        putString(
            "detectorImplementation",
            if (status == NativeExtractionStatus.UNSUPPORTED) "unavailable"
            else NativeExtractionConstants.DETECTOR_IMPLEMENTATION,
        )
        putString("detectorVersion", NativeExtractionConstants.DETECTOR_VERSION_MLKIT_POSE)
        putString("extractorVersion", NativeExtractionConstants.EXTRACTOR_VERSION)
        inputWidth?.let { putInt("inputWidth", it) }
        inputHeight?.let { putInt("inputHeight", it) }
        putParcelableArrayList("persons", ArrayList(persons.map { it.toBundle() }))
        detectionDurationMs?.let { putDouble("detectionDurationMs", it.toDouble()) }
        totalDurationMs?.let { putDouble("totalDurationMs", it.toDouble()) }
        putStringArrayList("warnings", ArrayList(warnings))
        errorCode?.let { putString("errorCode", it.name) }
        failureReason?.let { putString("failureReason", it) }
    }
}

data class NativeExtractionCapabilities(
    val personDetectionSupported: Boolean,
) {
    fun toBundle(): Bundle = Bundle().apply {
        putBoolean("personDetectionSupported", personDetectionSupported)
        putString("platform", "android")
        putString(
            "detectorImplementation",
            if (personDetectionSupported) NativeExtractionConstants.DETECTOR_IMPLEMENTATION
            else "unavailable",
        )
        putBoolean(
            "segmentationMaskSupported",
            NativeExtractionConstants.SEGMENTATION_MASK_SUPPORTED,
        )
        putStringArrayList(
            "supportedLandmarks",
            ArrayList(BodyLandmarkType.values().map { it.wireName }),
        )
        putInt("maxWidth", NativePrivacyConstants.MAX_WIDTH)
        putInt("maxHeight", NativePrivacyConstants.MAX_HEIGHT)
        putDouble("maxPixels", NativePrivacyConstants.MAX_PIXELS.toDouble())
        putString("extractorVersion", NativeExtractionConstants.EXTRACTOR_VERSION)
    }
}
