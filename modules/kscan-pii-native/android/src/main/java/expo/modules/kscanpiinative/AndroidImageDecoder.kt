package expo.modules.kscanpiinative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import java.io.File
import java.io.IOException

sealed class DecodeResult {
    data class Success(
        val bitmap: Bitmap,
        val mimeType: String,
        val width: Int,
        val height: Int,
    ) : DecodeResult()

    data class Failure(
        val errorCode: NativePrivacyErrorCode,
        val reason: String,
    ) : DecodeResult()
}

object AndroidImageDecoder {
    fun decodeFileUri(uriString: String): DecodeResult {
        val file = try {
            val uri = Uri.parse(uriString)
            if (uri.scheme != "file") {
                return DecodeResult.Failure(
                    NativePrivacyErrorCode.UNSUPPORTED_SCHEME,
                    "Unsupported URI scheme: ${uri.scheme}. Only file:// is accepted.",
                )
            }
            File(uri.path ?: "")
        } catch (e: Exception) {
            return DecodeResult.Failure(
                NativePrivacyErrorCode.INVALID_URI,
                "Failed to parse URI: ${e.message}",
            )
        }

        if (!file.exists() || !file.canRead()) {
            return DecodeResult.Failure(
                NativePrivacyErrorCode.INVALID_URI,
                "File does not exist or is not readable: ${file.absolutePath}",
            )
        }

        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeFile(file.absolutePath, options)

        val rawMimeType = options.outMimeType ?: ""
        if (rawMimeType !in NativePrivacyConstants.ACCEPTED_MIME_TYPES) {
            return DecodeResult.Failure(
                NativePrivacyErrorCode.UNSUPPORTED_FORMAT,
                "Unsupported image format: $rawMimeType. Accepted: ${NativePrivacyConstants.ACCEPTED_MIME_TYPES}.",
            )
        }

        val rawWidth = options.outWidth
        val rawHeight = options.outHeight
        if (rawWidth <= 0 || rawHeight <= 0) {
            return DecodeResult.Failure(
                NativePrivacyErrorCode.DECODE_FAILED,
                "Invalid image dimensions: ${rawWidth}x$rawHeight.",
            )
        }
        if (rawWidth > NativePrivacyConstants.MAX_WIDTH || rawHeight > NativePrivacyConstants.MAX_HEIGHT) {
            return DecodeResult.Failure(
                NativePrivacyErrorCode.IMAGE_TOO_LARGE,
                "Image dimensions ${rawWidth}x$rawHeight exceed the maximum of ${NativePrivacyConstants.MAX_WIDTH}x${NativePrivacyConstants.MAX_HEIGHT}.",
            )
        }
        val pixelCount = rawWidth.toLong() * rawHeight.toLong()
        if (pixelCount > NativePrivacyConstants.MAX_PIXELS) {
            return DecodeResult.Failure(
                NativePrivacyErrorCode.IMAGE_TOO_LARGE,
                "Pixel count $pixelCount exceeds the maximum of ${NativePrivacyConstants.MAX_PIXELS}.",
            )
        }

        val orientation = try {
            ExifInterface(file.absolutePath).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            )
        } catch (e: IOException) {
            return DecodeResult.Failure(
                NativePrivacyErrorCode.ORIENTATION_FAILED,
                "Failed to read EXIF orientation: ${e.message}",
            )
        }

        val decodeOptions = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val source = BitmapFactory.decodeFile(file.absolutePath, decodeOptions)
            ?: return DecodeResult.Failure(
                NativePrivacyErrorCode.DECODE_FAILED,
                "BitmapFactory.decodeFile returned null.",
            )

        val normalized = normalizeOrientation(source, orientation)
        if (normalized != source && source.isMutable.not()) {
            // If we created a new bitmap, recycle the original immutable one to avoid leaks.
            source.recycle()
        }

        return DecodeResult.Success(
            bitmap = normalized,
            mimeType = rawMimeType,
            width = normalized.width,
            height = normalized.height,
        )
    }

    private fun normalizeOrientation(source: Bitmap, orientation: Int): Bitmap {
        val (rotationDegrees, mirrorHorizontal) = when (orientation) {
            ExifInterface.ORIENTATION_NORMAL -> return source
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f to false
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f to false
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f to false
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> 0f to true
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> 180f to true
            ExifInterface.ORIENTATION_TRANSPOSE -> 90f to true
            ExifInterface.ORIENTATION_TRANSVERSE -> 270f to true
            else -> return source
        }

        val matrix = Matrix().apply {
            postRotate(rotationDegrees)
            if (mirrorHorizontal) {
                postScale(-1f, 1f)
            }
        }

        return Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
    }
}
