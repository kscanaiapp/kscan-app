package expo.modules.kscanlivevtonative

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint

import android.util.Log
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max
import kotlin.math.min

private const val TAG = "KScanLiveVtoN1B"

/** Logical render canvas size -- matches the P3-A reference oracle's
 *  NEUTRAL_PERSON fixture canvas (720x960) so geometry values are directly
 *  comparable without a rescale step. Drawn scaled-to-fit the real view. */
private const val RENDER_CANVAS_W = 720f
private const val RENDER_CANVAS_H = 960f

/** Amendment D24: at most one distinct diagnostic snapshot per second across the bridge. */
private const val DIAGNOSTIC_SNAPSHOT_MIN_INTERVAL_NANOS = 1_000_000_000L

/**
 * N1-B: renders one governed .ksgarment fixture (bundled under
 * android/src/main/assets/n1b-fixture/, copied verbatim from
 * fixtures/vto-phase4/generated/081350cef7f5c83e05c3e6c1 -- a real, ACCEPTED,
 * SYNTHETIC Phase 4 asset, not invented for this gate) through a canned
 * BodyFrame.neutral() pose, using the ported P3-A geometry
 * (LiveVtoGarmentAttachment.kt). Inert until `active` is set true (Expo
 * Prop) -- no work happens on mere mount.
 */
@SuppressLint("ViewConstructor")
class LiveVtoTestRenderView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var garmentBitmap: Bitmap? = null
  private var meshVerts: FloatArray? = null
  private var meshWidth = 0
  private var meshHeight = 0
  private var loadError: String? = null
  var lastSnapshot: GeometrySnapshot? = null
    private set
  private var cachedSnapshotJson: String? = null
  private var cachedSnapshotAtNanos: Long = 0L

  var active: Boolean = false
    set(value) {
      field = value
      if (value && garmentBitmap == null && loadError == null) loadAndCompute()
      invalidate()
    }

  private fun loadAndCompute() {
    try {
      val assets = context.assets
      val manifestText = assets.open("n1b-fixture/manifest.json").use { it.readBytes() }.toString(Charsets.UTF_8)
      val manifest = KsgarmentManifest.parseAssetManifest(manifestText)

      val textureBitmap = assets.open("n1b-fixture/${manifest.texture}").use { android.graphics.BitmapFactory.decodeStream(it) }
      val alphaBitmap = assets.open("n1b-fixture/${manifest.alphaMask}").use { android.graphics.BitmapFactory.decodeStream(it) }
      garmentBitmap = combineTextureAndAlpha(textureBitmap, alphaBitmap)

      // Exactly the same pure pipeline the conformance goldens run
      // (amendment D8) -- the view computes nothing of its own.
      val snapshot = LiveVtoGeometryPipeline.compute(
        manifest = manifest,
        frame = BodyFrame.neutral(),
        bodyFrameId = "neutral-frontal",
        canvasWidth = RENDER_CANVAS_W,
        canvasHeight = RENDER_CANVAS_H,
        textureWidth = textureBitmap.width,
        textureHeight = textureBitmap.height,
      )
      meshWidth = snapshot.meshWidth
      meshHeight = snapshot.meshHeight
      meshVerts = snapshot.meshVertices
      lastSnapshot = snapshot
      Log.d(TAG, "N1-B geometry snapshot: ${describeSnapshot(snapshot)}")
    } catch (t: Throwable) {
      loadError = t.message ?: t.toString()
      lastSnapshot = null
      Log.e(TAG, "N1-B render failed", t)
    }
  }

  /**
   * Diagnostic snapshot read, rate-limited (amendment D24).
   *
   * A caller that polls this cannot turn it into a per-frame geometry
   * channel: reads inside the window return the SAME cached string rather
   * than a fresh computation, and the bridge sees at most one distinct
   * snapshot per window regardless of call rate. Returns null before the
   * first compute.
   */
  fun readDiagnosticSnapshotJson(): String? {
    val snapshot = lastSnapshot ?: return null
    val now = System.nanoTime()
    val cached = cachedSnapshotJson
    if (cached != null && now - cachedSnapshotAtNanos < DIAGNOSTIC_SNAPSHOT_MIN_INTERVAL_NANOS) return cached
    val encoded = GeometrySnapshotJson.encode(snapshot, includeMesh = false)
    cachedSnapshotJson = encoded
    cachedSnapshotAtNanos = now
    return encoded
  }

  private fun computeBounds(points: Collection<Vec2>): Pair<Vec2, Vec2> {
    var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
    var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
    for (p in points) { minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y) }
    return Pair(Vec2(minX, minY), Vec2(maxX, maxY))
  }

  /**
   * Combines texture.png's RGB with alpha.png's coverage. Coverage is taken
   * as max(alpha.png's own alpha channel, alpha.png's luminance) so this
   * works whichever convention the pipeline used (a transparent-background
   * silhouette encodes coverage in alpha; an opaque grayscale mask encodes
   * it in luminance) without needing to hand-verify the exact PNG bytes --
   * documented simplification, revisit if a future fixture's alpha looks
   * wrong.
   */
  private fun combineTextureAndAlpha(texture: Bitmap, alpha: Bitmap): Bitmap {
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

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val bg = Paint().apply { color = Color.rgb(32, 32, 36) }
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bg)

    if (!active) return
    val err = loadError
    if (err != null) {
      val p = Paint().apply { color = Color.RED; textSize = 28f }
      canvas.drawText("N1-B render error: $err", 20f, 60f, p)
      return
    }
    val bitmap = garmentBitmap ?: return
    val verts = meshVerts

    canvas.save()
    val scaleX = width / RENDER_CANVAS_W
    val scaleY = height / RENDER_CANVAS_H
    val fitScale = min(scaleX, scaleY)
    canvas.scale(fitScale, fitScale)

    // Faint landmark markers for the canned pose -- visual alignment aid, not perception.
    val markerPaint = Paint().apply { color = Color.argb(160, 255, 255, 0); style = Paint.Style.FILL }
    val frame = BodyFrame.neutral()
    for (landmark in listOf(frame.leftShoulder, frame.rightShoulder, frame.leftHip, frame.rightHip, frame.leftElbow, frame.rightElbow)) {
      val p = landmark.pointOrNull()?.toCanvasPx(RENDER_CANVAS_W, RENDER_CANVAS_H) ?: continue
      canvas.drawCircle(p.x, p.y, 6f, markerPaint)
    }

    if (verts != null) {
      canvas.drawBitmapMesh(bitmap, meshWidth, meshHeight, verts, 0, null, 0, Paint().apply { isAntiAlias = true })
    } else {
      val p = Paint().apply { color = Color.RED; textSize = 24f }
      canvas.drawText("no mesh: ${lastSnapshot?.failure ?: lastSnapshot?.gateFindings}", 20f, 40f, p)
    }
    canvas.restore()
  }
}
