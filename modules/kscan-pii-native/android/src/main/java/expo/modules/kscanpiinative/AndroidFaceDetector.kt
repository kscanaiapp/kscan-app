package expo.modules.kscanpiinative

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

sealed class DetectionResult {
    data class Success(
        val faces: List<FaceRect>,
        val durationMs: Long,
    ) : DetectionResult()

    data class Failure(
        val errorCode: NativePrivacyErrorCode,
        val reason: String,
    ) : DetectionResult()
}

data class FaceRect(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
)

object AndroidFaceDetector {
    private val detector by lazy {
        val options = FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
            .setContourMode(FaceDetectorOptions.CONTOUR_MODE_NONE)
            .build()
        FaceDetection.getClient(options)
    }

    suspend fun detect(bitmap: Bitmap): DetectionResult {
        val inputImage = try {
            InputImage.fromBitmap(bitmap, 0)
        } catch (e: Exception) {
            return DetectionResult.Failure(
                NativePrivacyErrorCode.DETECTION_FAILED,
                "Failed to create ML Kit input image: ${e.message}",
            )
        }

        val startedAt = System.currentTimeMillis()
        return try {
            val faces = suspendCoroutine<List<Face>> { continuation ->
                detector.process(inputImage)
                    .addOnSuccessListener { continuation.resume(it) }
                    .addOnFailureListener { continuation.resumeWithException(it) }
            }
            val durationMs = System.currentTimeMillis() - startedAt
            DetectionResult.Success(
                faces = faces.map {
                    FaceRect(
                        left = it.boundingBox.left.toFloat(),
                        top = it.boundingBox.top.toFloat(),
                        right = it.boundingBox.right.toFloat(),
                        bottom = it.boundingBox.bottom.toFloat(),
                    )
                },
                durationMs = durationMs,
            )
        } catch (e: Exception) {
            DetectionResult.Failure(
                NativePrivacyErrorCode.DETECTION_FAILED,
                "ML Kit face detection failed: ${e.message}",
            )
        }
    }
}
