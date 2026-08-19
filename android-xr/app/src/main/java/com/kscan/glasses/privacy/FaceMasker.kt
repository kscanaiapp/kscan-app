package com.kscan.glasses.privacy

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.util.Base64
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.io.ByteArrayOutputStream

/**
 * On-device face region masking using ML Kit Face Detection.
 *
 * Production implementation:
 * - Detects faces locally on device (no cloud APIs)
 * - Applies irreversible solid mask over bounding boxes with padding
 * - Re-encodes masked output as JPEG
 * - Returns [MaskResult.NoFaces] when detector completes with zero faces
 * - Returns [MaskResult.Error] only on detector or encoding failure
 * - Does not use third-party cloud face APIs
 * - Does not persist bounding boxes, embeddings, or face counts
 */
class FaceMasker(
    faceDetector: FaceDetector? = null,
) {

    private val detector: FaceDetector by lazy {
        faceDetector ?: FaceDetection.getClient(
            FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
                .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
                .build()
        )
    }

    /**
     * True when on-device face masking is implemented and usable.
     */
    val isMaskingAvailable: Boolean
        get() = true

    fun maskFaces(base64: String, mimeType: String): MaskResult {
        if (base64.isBlank()) {
            return MaskResult.Error("Empty input")
        }

        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (_: Exception) {
            return MaskResult.Error("Base64 decode failed")
        }

        val bitmap = try {
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (_: Exception) {
            null
        } ?: return MaskResult.Error("Bitmap decode failed")

        if (bitmap.width <= 0 || bitmap.height <= 0) {
            return MaskResult.Error("Invalid bitmap dimensions")
        }

        val inputImage = InputImage.fromBitmap(bitmap, 0)

        val faces = try {
            com.google.android.gms.tasks.Tasks.await(detector.process(inputImage))
        } catch (_: Exception) {
            return MaskResult.Error("Face detection failed")
        }

        if (faces.isEmpty()) {
            return MaskResult.NoFaces(base64, mimeType)
        }

        // Apply irreversible solid mask over face bounding boxes with padding.
        val maskedBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(maskedBitmap)
        val paint = Paint().apply {
            isAntiAlias = true
            color = android.graphics.Color.BLACK
            style = Paint.Style.FILL
        }

        val paddingPx = (bitmap.width * 0.05f).toInt().coerceAtLeast(8)

        for (face in faces) {
            val box = face.boundingBox
            val paddedRect = Rect(
                (box.left - paddingPx).coerceAtLeast(0),
                (box.top - paddingPx).coerceAtLeast(0),
                (box.right + paddingPx).coerceAtMost(bitmap.width),
                (box.bottom + paddingPx).coerceAtMost(bitmap.height),
            )
            canvas.drawRect(paddedRect, paint)
        }

        // Encode masked bitmap to JPEG base64.
        // EXIF / GPS metadata guarantee: The source bytes are decoded into an
        // Android Bitmap, which discards all original metadata. The masked output
        // is rendered into a fresh ARGB_8888 bitmap and re-compressed as JPEG.
        // No EXIF, GPS, or original metadata survives this path.
        val outputStream = ByteArrayOutputStream()
        if (!maskedBitmap.compress(Bitmap.CompressFormat.JPEG, 85, outputStream)) {
            return MaskResult.Error("JPEG encode failed")
        }
        val maskedBase64 = Base64.encodeToString(outputStream.toByteArray(), Base64.NO_WRAP)

        return MaskResult.Success(maskedBase64, "image/jpeg")
    }
}

sealed class MaskResult {
    data class Success(val base64: String, val mimeType: String) : MaskResult()
    data class NoFaces(val base64: String, val mimeType: String) : MaskResult()
    data class NotImplemented(val reason: String) : MaskResult()
    data class Error(val message: String) : MaskResult()
}
