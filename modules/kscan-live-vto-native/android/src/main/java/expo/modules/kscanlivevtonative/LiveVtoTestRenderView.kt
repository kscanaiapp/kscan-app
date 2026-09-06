package expo.modules.kscanlivevtonative

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.util.Log
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

private const val TAG = "KScanLiveVtoN1B"

/** Logical render canvas size -- matches the P3-A reference oracle's
 *  NEUTRAL_PERSON fixture canvas (720x960) so geometry values are directly
 *  comparable without a rescale step. Drawn scaled-to-fit the real view. */
private const val RENDER_CANVAS_W = 720f
private const val RENDER_CANVAS_H = 960f

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
  var lastResult: N1BRenderResult? = null
    private set

  var active: Boolean = false
    set(value) {
      field = value
      if (value && garmentBitmap == null && loadError == null) loadAndCompute()
      invalidate()
    }

  private fun loadAndCompute() {
    try {
      val assets = context.assets
      val manifestJson = assets.open("n1b-fixture/manifest.json").use { it.readBytes() }.toString(Charsets.UTF_8)
      val ksgarmentJson = JSONObject(manifestJson).getJSONObject("ksgarment")
      val manifest = KsgarmentManifest.parse(ksgarmentJson)

      val textureBitmap = assets.open("n1b-fixture/${manifest.texture}").use { android.graphics.BitmapFactory.decodeStream(it) }
      val alphaBitmap = assets.open("n1b-fixture/${manifest.alphaMask}").use { android.graphics.BitmapFactory.decodeStream(it) }
      garmentBitmap = combineTextureAndAlpha(textureBitmap, alphaBitmap)

      val bodyFrame = BodyFrame.neutral()
      val anchors = extractBodyAnchors(bodyFrame, RENDER_CANVAS_W, RENDER_CANVAS_H)
        ?: throw IllegalStateException("canned BodyFrame missing required shoulder landmarks")
      val targets = computeControlPointTargets(anchors, manifest, textureBitmap.width, textureBitmap.height)
      val placement = fitRigidPlacement(manifest, targets, textureBitmap.width, textureBitmap.height)
      val gate = evaluateRigidGate(anchors, manifest, placement, textureBitmap.width, textureBitmap.height)

      meshWidth = manifest.meshDefinition.width
      meshHeight = manifest.meshDefinition.height
      meshVerts = if (gate.passed) {
        buildDeformedMeshVertices(manifest, targets.targets)
      } else {
        null // refuse to deform on a failed gate -- see evaluateRigidGate's doc comment
      }

      val bounds = computeBounds(targets.targets.values)
      lastResult = N1BRenderResult(
        assetId = manifest.productId,
        gatePassed = gate.passed,
        gateFindings = gate.findings,
        scale = placement.scale,
        rotationRadians = placement.rotationRadians,
        controlPointTargets = targets.targets.mapKeys { it.key.id }.mapValues { Pair(it.value.x, it.value.y) },
        boundsMinX = bounds.first.x, boundsMinY = bounds.first.y,
        boundsMaxX = bounds.second.x, boundsMaxY = bounds.second.y,
        canvasWidth = RENDER_CANVAS_W, canvasHeight = RENDER_CANVAS_H,
        error = null,
      )
      Log.d(TAG, "N1-B render computed: $lastResult")
    } catch (t: Throwable) {
      loadError = t.message ?: t.toString()
      lastResult = N1BRenderResult.error(loadError!!)
      Log.e(TAG, "N1-B render failed", t)
    }
  }

  private fun computeBounds(points: Collection<PointF>): Pair<PointF, PointF> {
    var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
    var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
    for (p in points) { minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y) }
    return Pair(PointF(minX, minY), PointF(maxX, maxY))
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
      canvas.drawText("rigid gate failed: ${lastResult?.gateFindings}", 20f, 40f, p)
    }
    canvas.restore()
  }
}

data class N1BRenderResult(
  val assetId: String,
  val gatePassed: Boolean,
  val gateFindings: List<String>,
  val scale: Float,
  val rotationRadians: Float,
  val controlPointTargets: Map<String, Pair<Float, Float>>,
  val boundsMinX: Float, val boundsMinY: Float, val boundsMaxX: Float, val boundsMaxY: Float,
  val canvasWidth: Float, val canvasHeight: Float,
  val error: String?,
) {
  companion object {
    fun error(message: String) = N1BRenderResult(
      "", false, emptyList(), 0f, 0f, emptyMap(), 0f, 0f, 0f, 0f, RENDER_CANVAS_W, RENDER_CANVAS_H, message
    )
  }
}
