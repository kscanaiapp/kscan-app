package expo.modules.kscanlivevtonative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Real Android software rasterization of governed assets and controlled poses.
 * No camera or MediaPipe certification is implied by this test. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LiveVtoRasterIntegrationTest {
  @Test fun controlledPoseRendersDistinctGarmentsAndCapturesPng() {
    val root = GoldenBodyFrames.moduleRoot()
    val output = File(root, "build/render-evidence").apply { mkdirs() }
    val empty = Bitmap.createBitmap(720, 960, Bitmap.Config.ARGB_8888)
    File(output, "empty.png").outputStream().use { empty.compress(Bitmap.CompressFormat.PNG, 100, it) }
    val signatures = mutableSetOf<Int>()
    for (key in listOf("n1b-fixture", "n1c-asym-fixture", "ascolour-5001-black-v1")) {
      val dir = File(root, "android/src/main/assets/$key")
      for (name in listOf("manifest.json", "texture.png", "alpha.png")) {
        val bytes = File(dir, name).readBytes()
        assertTrue(LiveVtoBundledAssetIntegrity.validate(key, name, bytes))
        val damaged = bytes.clone().also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertFalse(LiveVtoBundledAssetIntegrity.validate(key, name, damaged))
      }
      val (manifest, dims) = GoldenBodyFrames.fixture(key)
      val texture = BitmapFactory.decodeFile(File(dir, manifest.texture).path)
      val alpha = BitmapFactory.decodeFile(File(dir, manifest.alphaMask).path)
      val bitmap = LiveVtoRasterRenderer.combineTextureAndAlpha(texture, alpha)
      val snapshot = LiveVtoGeometryPipeline.compute(manifest, BodyFrame.neutral(), "controlled-neutral", 720f, 960f, dims.first, dims.second)
      assertTrue(snapshot.gatePassed)
      assertNotNull(snapshot.meshVertices)
      val frame = Bitmap.createBitmap(720, 960, Bitmap.Config.ARGB_8888)
      LiveVtoRasterRenderer.draw(Canvas(frame), bitmap, snapshot)
      val pixels = IntArray(720 * 960)
      frame.getPixels(pixels, 0, 720, 0, 0, 720, 960)
      assertTrue("empty renderer for $key", pixels.count { it ushr 24 != 0 } > 1000)
      assertTrue("unchanged garment for $key", signatures.add(pixels.contentHashCode()))
      val capture = File(output, "$key.png")
      capture.outputStream().use { assertTrue(frame.compress(Bitmap.CompressFormat.PNG, 100, it)) }
      assertNotNull(BitmapFactory.decodeFile(capture.path))
      val rejected = snapshot.copy(meshVertices = null)
      val invalid = Bitmap.createBitmap(720, 960, Bitmap.Config.ARGB_8888)
      LiveVtoRasterRenderer.draw(Canvas(invalid), bitmap, rejected)
      assertTrue(invalid.sameAs(empty))
    }
    assertFalse(LiveVtoBundledAssetIntegrity.validate("../unapproved", "texture.png", byteArrayOf()))
  }

  @Test fun modelBytesArePinnedAndCorruptionIsRejected() {
    val model = File(GoldenBodyFrames.moduleRoot(), "android/src/main/assets/models/pose_landmarker_lite.task").readBytes()
    assertTrue(LiveVtoModelIntegrity.isApproved(model))
    model[0] = (model[0].toInt() xor 1).toByte()
    assertFalse(LiveVtoModelIntegrity.isApproved(model))
    assertFalse(LiveVtoModelIntegrity.isApproved(byteArrayOf()))
  }
}
