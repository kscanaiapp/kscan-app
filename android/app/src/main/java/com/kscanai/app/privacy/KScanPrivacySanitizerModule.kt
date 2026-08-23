package com.kscanai.app.privacy

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Android-only, on-device, irreversible face masker. No image or detector artifacts are persisted. */
class KScanPrivacySanitizerModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "KScanPrivacySanitizer"

  @ReactMethod
  fun getStatus(promise: Promise) {
    promise.resolve(Arguments.createMap().apply {
      putBoolean("faceDetectionAvailable", true)
      putString("mode", "mlkit-local-solid-mask")
    })
  }

  @ReactMethod
  fun sanitizeJpeg(dataUri: String?, promise: Promise) {
    if (dataUri == null || !dataUri.startsWith(JPEG_PREFIX) || dataUri.length > MAX_INPUT_CHARS) {
      promise.reject("PRIVACY_INVALID_INPUT", "Privacy processing blocked the image")
      return
    }
    val bytes = try { Base64.decode(dataUri.substring(JPEG_PREFIX.length), Base64.DEFAULT) } catch (_: Exception) { null }
    if (bytes == null || bytes.isEmpty() || bytes.size > MAX_INPUT_BYTES) {
      promise.reject("PRIVACY_DECODE_FAILED", "Privacy processing blocked the image")
      return
    }
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    if (decoded == null || decoded.width < 2 || decoded.height < 2) {
      promise.reject("PRIVACY_DECODE_FAILED", "Privacy processing blocked the image")
      return
    }

    val detector = FaceDetection.getClient(
      FaceDetectorOptions.Builder()
        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
        .setMinFaceSize(0.05f)
        .build(),
    )
    detector.process(InputImage.fromBitmap(decoded, 0))
      .addOnSuccessListener { faces ->
        try {
          val mutable = decoded.copy(Bitmap.Config.ARGB_8888, true)
            ?: throw IllegalStateException("bitmap copy failed")
          val canvas = Canvas(mutable)
          val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; style = Paint.Style.FILL }
          faces.forEach { face ->
            val box = face.boundingBox
            val padX = (box.width() * 0.28f).roundToInt()
            val padY = (box.height() * 0.34f).roundToInt()
            val left = max(0, box.left - padX).toFloat()
            val top = max(0, box.top - padY).toFloat()
            val right = min(mutable.width, box.right + padX).toFloat()
            val bottom = min(mutable.height, box.bottom + padY).toFloat()
            canvas.drawRoundRect(left, top, right, bottom, 18f, 18f, paint)
          }
          val normalized = resize(mutable, MAX_OUTPUT_EDGE)
          val output = ByteArrayOutputStream()
          if (!normalized.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output)) {
            throw IllegalStateException("jpeg encode failed")
          }
          val encoded = output.toByteArray()
          if (encoded.isEmpty() || encoded.size > MAX_OUTPUT_BYTES) throw IllegalStateException("invalid output")
          promise.resolve(Arguments.createMap().apply {
            putString("dataUri", JPEG_PREFIX + Base64.encodeToString(encoded, Base64.NO_WRAP))
            putInt("facesMasked", faces.size)
            putInt("width", normalized.width)
            putInt("height", normalized.height)
          })
          if (normalized !== mutable) normalized.recycle()
          mutable.recycle()
        } catch (_: Exception) {
          promise.reject("PRIVACY_MASK_FAILED", "Privacy processing blocked the image")
        } finally {
          detector.close()
          decoded.recycle()
        }
      }
      .addOnFailureListener {
        detector.close()
        decoded.recycle()
        promise.reject("PRIVACY_DETECTOR_FAILED", "Privacy processing blocked the image")
      }
  }

  private fun resize(bitmap: Bitmap, maxEdge: Int): Bitmap {
    val edge = max(bitmap.width, bitmap.height)
    if (edge <= maxEdge) return bitmap
    val scale = maxEdge.toFloat() / edge.toFloat()
    return Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).roundToInt(), (bitmap.height * scale).roundToInt(), true)
  }

  companion object {
    private const val JPEG_PREFIX = "data:image/jpeg;base64,"
    private const val MAX_INPUT_CHARS = 12_000_000
    private const val MAX_INPUT_BYTES = 8_000_000
    private const val MAX_OUTPUT_BYTES = 4_000_000
    private const val MAX_OUTPUT_EDGE = 896
    private const val JPEG_QUALITY = 70
  }
}
