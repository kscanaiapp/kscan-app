package com.kscan.glasses.privacy

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * Deterministic failure classification for the JPEG re-encode boundary.
 * Failures carry NO payload data and NO input-derived message — only the class.
 */
enum class CompressFailure {
    /** Input base64 was blank. */
    EMPTY_INPUT,

    /** Base64 or image bytes could not be decoded into a bitmap. */
    DECODE_FAILED,

    /** Bitmap decoded but has non-positive dimensions. */
    INVALID_DIMENSIONS,

    /** A new bitmap could not be reconstructed from the decoded source. */
    RECONSTRUCT_FAILED,

    /** JPEG encoding of the reconstructed bitmap failed. */
    ENCODE_FAILED,
}

sealed class CompressResult {
    /** Newly encoded JPEG bytes (base64). Never the original byte array. */
    data class Success(val base64: String, val mimeType: String) : CompressResult()

    /** Deterministic failure; contains no payload and no raw input. */
    data class Failure(val failure: CompressFailure) : CompressResult()
}

/** Decode boundary (injectable for failure-path tests). */
fun interface BitmapDecoder {
    fun decode(bytes: ByteArray): Bitmap?
}

/** Encode boundary (injectable for failure-path tests). Returns null or throws on failure. */
fun interface JpegEncoder {
    fun encode(bitmap: Bitmap, quality: Int): ByteArray?
}

/** EXIF orientation boundary (injectable for tests). */
fun interface ExifOrientationProvider {
    /** Returns an EXIF orientation constant (1–8) or [ExifInterface.ORIENTATION_UNDEFINED]. */
    fun orientationFor(jpegBytes: ByteArray): Int
}

/**
 * Real image output boundary: decode -> normalize EXIF orientation -> bound long
 * side -> reconstruct a NEW bitmap -> encode a NEW JPEG.
 *
 * Guarantees:
 * - Output is ALWAYS newly encoded bytes; the original byte array is never
 *   returned under any circumstance (including every failure condition).
 * - Reconstruction discards original metadata (EXIF and other markers are not
 *   carried through [Bitmap.compress]).
 * - No raw payload logging. Failures are classified deterministically and carry
 *   no input-derived data.
 *
 * JPEG quality is fixed at 75: mid-band of the allowed 65–85 range, balancing
 * analyze-model input fidelity against debug-uplink payload size. Callers may
 * override within 65–85; values outside are coerced to the allowed band.
 */
class ImageCompressor(
    private val decoder: BitmapDecoder = BitmapDecoder { bytes ->
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    },
    private val encoder: JpegEncoder = JpegEncoder { bitmap, quality ->
        val out = ByteArrayOutputStream()
        if (bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) out.toByteArray() else null
    },
    private val exifOrientation: ExifOrientationProvider = ExifOrientationProvider { bytes ->
        try {
            ExifInterface(ByteArrayInputStream(bytes))
                .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED)
        } catch (_: Exception) {
            // A malformed/absent EXIF segment must not kill an otherwise valid image.
            ExifInterface.ORIENTATION_UNDEFINED
        }
    },
) {

    companion object {
        const val MAX_LONG_SIDE_PX = 896
        const val JPEG_QUALITY = 75
        const val MIN_QUALITY = 65
        const val MAX_QUALITY = 85
    }

    fun compressJpeg(base64: String, quality: Int = JPEG_QUALITY): CompressResult {
        if (base64.isBlank()) {
            return CompressResult.Failure(CompressFailure.EMPTY_INPUT)
        }

        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (_: Exception) {
            return CompressResult.Failure(CompressFailure.DECODE_FAILED)
        }

        // JPEG boundary contract: only JPEG input is accepted. Checking the SOI
        // magic bytes here keeps failure classification deterministic regardless
        // of how lenient the platform decoder is (real device vs. test shadows).
        if (!isJpeg(bytes)) {
            return CompressResult.Failure(CompressFailure.DECODE_FAILED)
        }

        val decoded = try {
            decoder.decode(bytes)
        } catch (_: Exception) {
            null
        } ?: return CompressResult.Failure(CompressFailure.DECODE_FAILED)

        val width = decoded.width
        val height = decoded.height
        if (width <= 0 || height <= 0) {
            return CompressResult.Failure(CompressFailure.INVALID_DIMENSIONS)
        }

        val orientation = try {
            exifOrientation.orientationFor(bytes)
        } catch (_: Exception) {
            ExifInterface.ORIENTATION_UNDEFINED
        }

        // Reconstruct a NEW bitmap with orientation normalized and long side bounded.
        val matrix = Matrix().apply {
            applyOrientation(orientation)
            val longSide = maxOf(width, height)
            if (longSide > MAX_LONG_SIDE_PX) {
                val scale = MAX_LONG_SIDE_PX.toFloat() / longSide.toFloat()
                postScale(scale, scale)
            }
        }

        val transformed = try {
            Bitmap.createBitmap(decoded, 0, 0, width, height, matrix, true)
        } catch (_: Exception) {
            null
        }

        // createBitmap may return the source instance for an identity transform;
        // copy guarantees the encode input is always a NEW bitmap.
        val rebuilt = when {
            transformed == null -> decoded.copy(
                decoded.config ?: Bitmap.Config.ARGB_8888,
                false,
            )
            transformed === decoded -> decoded.copy(
                decoded.config ?: Bitmap.Config.ARGB_8888,
                false,
            )
            else -> transformed
        } ?: return CompressResult.Failure(CompressFailure.RECONSTRUCT_FAILED)

        val jpegBytes = try {
            encoder.encode(rebuilt, quality.coerceIn(MIN_QUALITY, MAX_QUALITY))
        } catch (_: Exception) {
            null
        }
        if (jpegBytes == null || jpegBytes.isEmpty()) {
            return CompressResult.Failure(CompressFailure.ENCODE_FAILED)
        }

        return CompressResult.Success(
            base64 = Base64.encodeToString(jpegBytes, Base64.NO_WRAP),
            mimeType = "image/jpeg",
        )
    }

    /** JPEG Start-Of-Image marker check (FF D8 FF). */
    private fun isJpeg(bytes: ByteArray): Boolean =
        bytes.size >= 3 &&
            bytes[0] == 0xFF.toByte() &&
            bytes[1] == 0xD8.toByte() &&
            bytes[2] == 0xFF.toByte()

    /**
     * Maps all eight EXIF orientation values onto a normalization matrix
     * (mirrored variants included). Unknown/undefined values are treated as
     * normal (no transform).
     */
    private fun Matrix.applyOrientation(orientation: Int) {        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                postScale(-1f, 1f)
                postRotate(90f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                postScale(-1f, 1f)
                postRotate(270f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(270f)
            else -> Unit // ORIENTATION_NORMAL / ORIENTATION_UNDEFINED / unknown
        }
    }
}
