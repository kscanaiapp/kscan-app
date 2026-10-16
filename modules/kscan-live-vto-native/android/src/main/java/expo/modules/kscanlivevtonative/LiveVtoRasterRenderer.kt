package expo.modules.kscanlivevtonative

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import kotlin.math.max

/** The production software rasterizer, shared by the native view and pixel tests. */
object LiveVtoRasterRenderer {
  fun combineTextureAndAlpha(texture: Bitmap, alpha: Bitmap): Bitmap {
    val w = texture.width; val h = texture.height
    val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val texPixels = IntArray(w * h); texture.getPixels(texPixels, 0, w, 0, 0, w, h)
    val alphaScaled = if (alpha.width == w && alpha.height == h) alpha else Bitmap.createScaledBitmap(alpha, w, h, true)
    val alphaPixels = IntArray(w * h); alphaScaled.getPixels(alphaPixels, 0, w, 0, 0, w, h)
    val outPixels = IntArray(w * h)
    for (i in 0 until w * h) {
      val tp = texPixels[i]
      val ap = alphaPixels[i]
      val alphaChannel = Color.alpha(ap)
      val luminance = (Color.red(ap) * 3 + Color.green(ap) * 6 + Color.blue(ap)) / 10
      val coverage = max(alphaChannel, luminance)
      outPixels[i] = Color.argb(coverage, Color.red(tp), Color.green(tp), Color.blue(tp))
    }
    out.setPixels(outPixels, 0, w, 0, 0, w, h)
    return out
  }

  fun draw(canvas: Canvas, bitmap: Bitmap, snapshot: GeometrySnapshot) {
    val vertices = snapshot.meshVertices ?: return
    require(snapshot.validate().isEmpty()) { "INVALID_RENDER_GEOMETRY" }
    canvas.drawBitmapMesh(bitmap, snapshot.meshWidth, snapshot.meshHeight, vertices, 0, null, 0, Paint().apply { isAntiAlias = true })
  }
}
