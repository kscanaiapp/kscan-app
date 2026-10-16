package expo.modules.kscanlivevtonative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import androidx.camera.core.ImageProxy
import java.io.ByteArrayOutputStream

/**
 * N1-F: converts a CameraX `ImageAnalysis` frame (`ImageProxy`, YUV_420_888,
 * sensor-space, arbitrary rotation) into the `Bitmap` the EXISTING N1-E
 * perception provider already expects (`BitmapPerceptionInputFrame` --
 * `LiveVtoMediaPipePoseProvider.kt`). This is the ONLY new piece perception
 * needed: the provider, the adapter, the rigid gate, the deformation, and
 * the renderer are all reused completely unmodified (mission section 7:
 * "Do NOT create a second pose pipeline").
 *
 * ── The mirror decision (mission section 9; N1-E's own forward note) ──────
 *
 * `LiveVtoBodyFrameAdapter`'s header comment already states the contract
 * this function exists to satisfy: "BodyFrame's own contract is documented
 * as front-camera-mirrored... that describes what a LIVE CAMERA frame is
 * expected to look like once N1-F applies its own mirror transform at the
 * camera-input stage." This is that transform, applied ONCE, here, to the
 * actual pixels handed to the perception provider -- never again downstream
 * (the adapter does a direct, unflipped 1:1 mapping; the geometry pipeline
 * never touches raw pixels at all). This is also the ONLY mirror the garment
 * mesh needs: because the mesh's control points are derived from a
 * `BodyFrame` computed from this already-mirrored bitmap, and CameraX's own
 * `PreviewView` mirrors the live front-camera preview automatically (its
 * documented default behaviour, not something this module configures), both
 * the displayed video and the mesh overlay end up in the SAME mirrored
 * coordinate space without a second, independent flip anywhere -- exactly
 * mission section 9's "mirror the displayed video, never the garment
 * texture... do not compensate for mirroring in multiple layers." The
 * garment BITMAP's own pixels are never flipped by this file or by the
 * renderer; only the once-mirrored camera bitmap and the BodyFrame derived
 * from it are.
 *
 * ── Why a JPEG round-trip, not a direct YUV->RGB matrix (mission section 34) ──
 *
 * A hand-rolled YUV_420_888->ARGB conversion (accounting for row/pixel
 * stride per plane, which varies by device/vendor) is real complexity this
 * lane does not need to take on to hit its own showability target: pose
 * inference itself, not this conversion, is the dominant per-frame cost
 * (see docs/vto-live-native-n1-perception.md's measured MediaPipe latency).
 * `YuvImage.compressToJpeg` is a supported Android API that handles NV21
 * stride/plane conversion correctly and is fast enough for a bounded,
 * latest-frame-wins pipeline where a slow conversion simply drops more
 * frames (mission section 8) rather than corrupting anything. Documented,
 * revisitable simplification -- not a defect -- if a future performance
 * pass needs it.
 */
object LiveVtoCameraFrameConverter {

  /**
   * @param mirror true for the front camera (selfie convention); false for
   *   the back camera. Applied as a single horizontal flip alongside the
   *   sensor's own reported rotation, in one matrix, so a frame is never
   *   flipped by one stage and un-flipped (or re-flipped) by another.
   */
  fun toBitmap(imageProxy: ImageProxy, mirror: Boolean): Bitmap {
    val nv21 = yuv420888ToNv21(imageProxy)
    val yuvImage = YuvImage(nv21, ImageFormat.NV21, imageProxy.width, imageProxy.height, null)
    val out = ByteArrayOutputStream()
    yuvImage.compressToJpeg(Rect(0, 0, imageProxy.width, imageProxy.height), 90, out)
    val bytes = out.toByteArray()
    val upright = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      ?: throw IllegalStateException("camera frame JPEG decode returned null")

    val rotationDegrees = imageProxy.imageInfo.rotationDegrees
    if (rotationDegrees == 0 && !mirror) return upright

    val matrix = Matrix().apply {
      if (rotationDegrees != 0) postRotate(rotationDegrees.toFloat())
      // Mirror LAST, in the same matrix, so rotation and mirror are one
      // transform applied once -- not two transforms whose order could
      // silently swap left/right (mission section 10/11: a left/right or
      // upside-down mistake here is P0, no tolerance).
      if (mirror) postScale(-1f, 1f)
    }
    val transformed = Bitmap.createBitmap(upright, 0, 0, upright.width, upright.height, matrix, true)
    if (transformed !== upright) upright.recycle()
    return transformed
  }

  /**
   * `ImageProxy.PlaneProxy` for YUV_420_888 may report row/pixel strides
   * that differ from a tightly-packed NV21 buffer (device/vendor-specific).
   * This copies byte-by-byte respecting both strides rather than assuming
   * either is tightly packed -- a stride assumption here is exactly the
   * kind of "looks fine on one device, corrupts frames on another" defect
   * mission section 34's hard-problem ceiling is about.
   */
  private fun yuv420888ToNv21(image: ImageProxy): ByteArray {
    val width = image.width
    val height = image.height
    val ySize = width * height
    val uvSize = width * height / 4
    val nv21 = ByteArray(ySize + uvSize * 2)

    val yPlane = image.planes[0]
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]

    var pos = 0
    val yBuffer = yPlane.buffer
    val yRowStride = yPlane.rowStride
    val yPixelStride = yPlane.pixelStride
    for (row in 0 until height) {
      var col = 0
      var bufferIndex = row * yRowStride
      while (col < width) {
        nv21[pos++] = yBuffer.get(bufferIndex)
        bufferIndex += yPixelStride
        col++
      }
    }

    // NV21 interleaves V,U (not U,V). `vPlane`/`uPlane` for YUV_420_888 are
    // documented to alias the same underlying interleaved buffer on most
    // devices, but this reads each plane independently rather than relying
    // on that aliasing, so it is correct even when a provider genuinely
    // returns separate, non-interleaved U/V planes.
    val uvRowStride = vPlane.rowStride
    val uvPixelStride = vPlane.pixelStride
    val vBuffer = vPlane.buffer
    val uBuffer = uPlane.buffer
    val chromaHeight = height / 2
    val chromaWidth = width / 2
    for (row in 0 until chromaHeight) {
      var col = 0
      while (col < chromaWidth) {
        val vIndex = row * uvRowStride + col * uvPixelStride
        val uIndex = row * uvRowStride + col * uvPixelStride
        nv21[pos++] = vBuffer.get(vIndex)
        nv21[pos++] = uBuffer.get(uIndex)
        col++
      }
    }
    return nv21
  }
}
