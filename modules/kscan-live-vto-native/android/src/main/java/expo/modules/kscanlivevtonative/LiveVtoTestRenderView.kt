package expo.modules.kscanlivevtonative

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import android.view.ViewGroup
import androidx.camera.view.PreviewView
import androidx.lifecycle.LifecycleOwner

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

  init {
    // N1-ENV-012 (P0). ROOT CAUSE (confirmed by direct onDraw
    // instrumentation, not by inference): `ExpoView` extends `LinearLayout`
    // -- a ViewGroup -- and Android's `ViewGroup` constructor calls
    // `setWillNotDraw(true)` by default, on the assumption that a group
    // normally draws nothing of its own and only composites its children.
    // This class overrides `onDraw(Canvas)` to paint directly, but never
    // told the View system to expect that, so `onDraw` was never invoked
    // AT ALL -- not the background fill, not the landmark markers, not the
    // error text, not the mesh. Every one of those is a plain Canvas
    // primitive; none of them is specific to `drawBitmapMesh`, which is
    // why an earlier hypothesis (hardware-acceleration incompatibility with
    // the mesh-warp draw path specifically) was wrong and is corrected here
    // rather than left uncorrected in a comment.
    //
    // FOUND BY the mandatory physical-device screenshot (amendment D2) --
    // it is the concrete reason that requirement exists. Geometry
    // conformance (amendment D8) measures the SAME pipeline this view
    // draws from and was correct throughout; "does this View actually
    // paint anything on a real device" is a different question, and nothing
    // in the numeric harness could ever have caught this, on any device or
    // emulator, since N1-B's inception.
    //
    // Fix: explicitly opt back into onDraw being called.
    setWillNotDraw(false)
    // Cheap insurance, not the fix: `drawBitmapMesh` has a documented
    // history of hardware-acceleration edge cases on some Android versions.
    // Software-backed Canvas costs nothing on a View this small and this
    // infrequently redrawn, and removes an entire class of "it depends on
    // the GPU driver" risk from a diagnostic surface that exists to be
    // trustworthy evidence.
    setLayerType(View.LAYER_TYPE_SOFTWARE, null)
  }

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

  // ── N1-D replay ─────────────────────────────────────────────────────────
  private var replaySession: LiveVtoReplaySession? = null
  private var replayDriver: LiveVtoReplayDriver? = null
  private var replayBitmaps = mutableMapOf<String, Bitmap>()
  @Volatile private var replayEvent: ReplayEvent? = null
  @Volatile private var replayBitmap: Bitmap? = null

  /**
   * Starts/stops the native replay clock. All production and deformation
   * runs on the driver's own thread; this view only draws whatever snapshot
   * is currently in the session's latest-state slot.
   */
  var replay: Boolean = false
    set(value) {
      field = value
      if (value) startReplay() else stopReplay()
      invalidate()
    }

  private fun loadFixture(name: String): Triple<KsgarmentManifest, Bitmap, Pair<Int, Int>> {
    val assets = context.assets
    val manifest = KsgarmentManifest.parseAssetManifest(
      assets.open("$name/manifest.json").use { it.readBytes() }.toString(Charsets.UTF_8)
    )
    val texture = assets.open("$name/${manifest.texture}").use { android.graphics.BitmapFactory.decodeStream(it) }
    val alpha = assets.open("$name/${manifest.alphaMask}").use { android.graphics.BitmapFactory.decodeStream(it) }
    val combined = replayBitmaps.getOrPut(name) { combineTextureAndAlpha(texture, alpha) }
    return Triple(manifest, combined, Pair(texture.width, texture.height))
  }

  private fun startReplay() {
    if (replayDriver != null) return
    try {
      val (manifest, bitmap, dims) = loadFixture("n1b-fixture")
      replayBitmap = bitmap
      val session = LiveVtoReplaySession(RENDER_CANVAS_W, RENDER_CANVAS_H) { event ->
        // Bounded state event only. Never a frame, never a BodyFrame,
        // never geometry -- amendment D24.
        replayEvent = event
        // Bounded state log. Aggregate counters are appended at terminal
        // states so replay evidence does not depend on a JS probe
        // surviving long enough to poll -- amendment D24 allows state
        // and performance summaries, and this is both.
        val terminal = event.state == ReplayState.EOF || event.state == ReplayState.STOPPED ||
          event.state == ReplayState.ERROR || event.state == ReplayState.DISPOSED
        val detail = if (terminal) " " + (readReplayStatsJson() ?: "") else ""
        Log.d(TAG, "N1-D replay state: " + event.state.name + detail)
        postInvalidate()
      }
      val source = InterpolatedPoseReplaySource(
        id = "n1d-neutral-armraise-neutral",
        keyframes = listOf(BodyFrame.neutral(), BodyFrame.armsSlightlyOut(), BodyFrame.neutral()),
        framesPerSegment = 60,
      )
      if (!session.load(source, manifest, dims.first, dims.second)) {
        loadError = "replay load refused"
        return
      }
      session.start()
      replaySession = session
      replayDriver = LiveVtoReplayDriver(session).also { it.start() }
    } catch (t: Throwable) {
      loadError = t.message ?: t.toString()
      Log.e(TAG, "N1-D replay start failed", t)
    }
  }

  private fun stopReplay() {
    replayDriver?.stop()
    replayDriver = null
    replaySession?.dispose()
    replaySession = null
    replayBitmap = null
  }

  // ── N1-E perception ───────────────────────────────────────────────────────
  private var perceptionSession: LiveVtoPerceptionSession? = null
  private var perceptionDriver: LiveVtoPerceptionDriver? = null
  private var perceptionBitmap: Bitmap? = null

  /**
   * Starts/stops the real perception pipeline: bundled synthetic replay
   * frame -> real MediaPipe inference -> BodyFrame adapter -> existing
   * geometry pipeline -> renderer. Mirrors `replay`'s prop pattern exactly.
   */
  var perception: Boolean = false
    set(value) {
      field = value
      if (value) startPerception() else stopPerception()
      invalidate()
    }

  private fun startPerception() {
    if (perceptionDriver != null) return
    try {
      val (manifest, bitmap, dims) = loadFixture("n1b-fixture")
      perceptionBitmap = bitmap
      val testFrame = context.assets.open("perception/synthetic-test-frame.png").use {
        android.graphics.BitmapFactory.decodeStream(it)
      }
      val provider = LiveVtoMediaPipePoseProvider(context)
      val gatePassCount = java.util.concurrent.atomic.AtomicLong(0)
      val gateFailCount = java.util.concurrent.atomic.AtomicLong(0)
      val session = LiveVtoPerceptionSession(
        provider, RENDER_CANVAS_W, RENDER_CANVAS_H,
        onEvent = { event ->
          perceptionEvent = event
          val terminal = event.state == ReplayState.ERROR || event.state == ReplayState.STOPPED || event.state == ReplayState.DISPOSED
          val detail = if (terminal) " " + (readPerceptionStatsJson() ?: "") else ""
          Log.d(TAG, "N1-E perception state: " + event.state.name + detail)
          postInvalidate()
        },
        onSnapshotComputed = { snapshot ->
          // DIAGNOSTIC ONLY (not part of the bounded bridge surface): logs
          // an aggregate gate-pass/fail tally every 50 computed snapshots,
          // so a hostile-audit reader can tell from logcat alone whether
          // the rigid gate is passing at all for this synthetic test frame,
          // rather than only ever seeing "rendered=N" (which counts a
          // successfully-consumed snapshot regardless of gate outcome).
          val total = if (snapshot.gatePassed) gatePassCount.incrementAndGet() else gateFailCount.incrementAndGet()
          if (total % 50 == 0L || total == 1L) {
            Log.d(TAG, "N1-E gate tally: passed=" + gatePassCount.get() + " failed=" + gateFailCount.get() +
              " lastGateFindings=" + snapshot.gateFindings + " lastScale=" + snapshot.scale)
          }
        },
      )
      if (!session.load(manifest, dims.first, dims.second)) {
        loadError = "perception load refused: ${session.currentState()}"
        return
      }
      session.start()
      perceptionSession = session
      perceptionDriver = LiveVtoPerceptionDriver(session, { BitmapPerceptionInputFrame(testFrame) }).also { it.start() }
    } catch (t: Throwable) {
      loadError = t.message ?: t.toString()
      Log.e(TAG, "N1-E perception start failed", t)
    }
  }

  private fun stopPerception() {
    perceptionDriver?.stop()
    perceptionDriver = null
    perceptionSession?.dispose()
    perceptionSession = null
    perceptionBitmap = null
  }

  @Volatile private var perceptionEvent: ReplayEvent? = null

  /** Bounded perception telemetry for gate evidence. Aggregate counters only -- amendment/mission section 26. */
  fun readPerceptionStatsJson(): String? {
    val session = perceptionSession ?: return null
    val stats = session.stats()
    return "{\"state\":\"" + session.currentState().name + "\"" +
      ",\"produced\":" + stats.produced +
      ",\"submittedToPerception\":" + stats.submittedToPerception +
      ",\"inferred\":" + stats.inferred +
      ",\"droppedBeforePerception\":" + stats.droppedBeforePerception +
      ",\"refused\":" + stats.refused +
      ",\"rendered\":" + stats.rendered +
      ",\"droppedBeforeRender\":" + stats.droppedBeforeRender +
      ",\"maxInputSlotDepth\":" + stats.maxInputSlotDepth +
      ",\"maxGeometrySlotDepth\":" + stats.maxGeometrySlotDepth + "}"
  }

  // ── N1-F camera-live ──────────────────────────────────────────────────────
  private var cameraController: LiveVtoCameraController? = null
  private var cameraPerceptionSession: LiveVtoPerceptionSession? = null
  private var cameraPerceptionDriver: LiveVtoPerceptionDriver? = null
  private var cameraBitmap: Bitmap? = null
  private var previewView: PreviewView? = null
  @Volatile private var cameraControllerState: CameraControllerState = CameraControllerState.IDLE
  @Volatile private var cameraControllerError: String? = null

  /**
   * Starts/stops the SAME real perception pipeline `perception` already
   * proved (MediaPipe -> BodyFrameAdapter -> rigid gate -> deformation ->
   * renderer), sourced from a LIVE front camera instead of the bundled
   * synthetic frame (mission section 7). Deliberately a SEPARATE session/
   * driver pair from `perception`'s, mirroring this file's own established
   * pattern of one independent prop+session+driver per phase (N1-D's
   * `replay`, N1-E's `perception`) rather than retrofitting a shared
   * abstraction onto an already-tested path.
   */
  var camera: Boolean = false
    set(value) {
      field = value
      if (value) startCamera() else stopCamera()
      invalidate()
    }

  private fun startCamera() {
    if (cameraController != null) return
    val activity = appContext.currentActivity
    val lifecycleOwner = activity as? LifecycleOwner
    if (lifecycleOwner == null) {
      loadError = "camera start refused: current Activity is not a LifecycleOwner"
      return
    }
    try {
      val (manifest, bitmap, dims) = loadFixture("n1b-fixture")
      cameraBitmap = bitmap

      val pv = PreviewView(context).apply {
        // N1-F device certification (2026-09-06): PreviewView's default
        // ImplementationMode.PERFORMANCE backs itself with a SurfaceView.
        // This host view (LiveVtoTestRenderView) forces
        // `LAYER_TYPE_SOFTWARE` on itself in `init{}` (N1-B's drawBitmapMesh
        // hardware-acceleration fix) -- a SurfaceView nested inside a
        // software-layer parent never actually receives frames from the
        // camera HAL even though CameraX reports RUNNING (confirmed on a
        // real device: `dumpsys media.camera` showed the camera device
        // opened but its capture session stuck `UNCONFIGURED`, and logcat
        // showed `SurfaceView ... updateSurface: has no frame` in a tight
        // loop). `COMPATIBLE` mode backs the preview with a `TextureView`
        // instead, which is a normal View that composites correctly under
        // a software-layer parent -- CameraX's own documented reason this
        // mode exists.
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
      }
      previewView = pv
      addView(pv, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

      val controller = LiveVtoCameraController(
        context = context,
        lifecycleOwner = lifecycleOwner,
        previewView = pv,
        onStateChanged = { state, reason ->
          cameraControllerState = state
          cameraControllerError = reason
          Log.d(TAG, "N1-F camera controller state: $state" + (reason?.let { " reason=$it" } ?: ""))
          postInvalidate()
        },
      )
      cameraController = controller

      val provider = LiveVtoMediaPipePoseProvider(context)
      val session = LiveVtoPerceptionSession(
        provider, RENDER_CANVAS_W, RENDER_CANVAS_H,
        onEvent = { event ->
          perceptionEvent = event
          postInvalidate()
        },
      )
      if (!session.load(manifest, dims.first, dims.second)) {
        loadError = "camera perception load refused: ${session.currentState()}"
        return
      }
      session.start()
      cameraPerceptionSession = session
      cameraPerceptionDriver = LiveVtoPerceptionDriver(session, { controller.latestFrame() }).also { it.start() }
      // The camera producer (CameraX's own analyzer callback) starts only
      // once the perception session is READY to receive frames -- starting
      // it first would let camera-produced frames pile up against a slot
      // nothing is draining yet, which `LatestStateSlot` would count as
      // drops that never represented real backpressure.
      controller.start()
    } catch (t: Throwable) {
      loadError = t.message ?: t.toString()
      Log.e(TAG, "N1-F camera start failed", t)
    }
  }

  private fun stopCamera() {
    cameraPerceptionDriver?.stop()
    cameraPerceptionDriver = null
    cameraPerceptionSession?.dispose()
    cameraPerceptionSession = null
    cameraController?.stop()
    cameraController = null
    cameraBitmap = null
    previewView?.let { removeView(it) }
    previewView = null
  }

  /**
   * Bounded end-to-end telemetry for gate evidence: the camera boundary's
   * own produced/dropped counters (mission section 8's CAMERA PRODUCED /
   * MAX PENDING) alongside the SAME perception counters `perception`
   * already exposes for the downstream stages. Never a frame, a landmark,
   * or a BodyFrame.
   */
  fun readCameraStatsJson(): String? {
    val controller = cameraController ?: return null
    val session = cameraPerceptionSession
    val stats = session?.stats()
    return "{\"controllerState\":\"" + cameraControllerState.name + "\"" +
      ",\"controllerError\":" + (cameraControllerError?.let { "\"" + it.replace("\"", "'") + "\"" } ?: "null") +
      ",\"cameraProduced\":" + controller.frameSlot.publishedCount +
      ",\"cameraConsumedByPerceptionTick\":" + controller.frameSlot.consumedCount +
      ",\"cameraDroppedBeforePerceptionTick\":" + controller.frameSlot.droppedCount +
      ",\"perceptionState\":\"" + (session?.currentState()?.name ?: "NONE") + "\"" +
      ",\"submittedToPerception\":" + (stats?.submittedToPerception ?: 0) +
      ",\"inferred\":" + (stats?.inferred ?: 0) +
      ",\"droppedBeforePerception\":" + (stats?.droppedBeforePerception ?: 0) +
      ",\"refused\":" + (stats?.refused ?: 0) +
      ",\"rendered\":" + (stats?.rendered ?: 0) +
      ",\"droppedBeforeRender\":" + (stats?.droppedBeforeRender ?: 0) + "}"
  }

  private fun drawCameraOverlay(canvas: Canvas) {
    val session = cameraPerceptionSession
    val bitmap = cameraBitmap
    if (session == null || bitmap == null) return
    val snapshot = session.consumeForRender() ?: session.geometrySlot.peek()
    val verts = snapshot?.meshVertices
    canvas.save()
    val fitScale = min(width / RENDER_CANVAS_W, height / RENDER_CANVAS_H)
    canvas.scale(fitScale, fitScale)
    if (verts != null) {
      canvas.drawBitmapMesh(bitmap, snapshot.meshWidth, snapshot.meshHeight, verts, 0, null, 0, Paint().apply { isAntiAlias = true })
    }
    canvas.restore()
    canvas.drawText(
      "camera=" + cameraControllerState.name + " " + (session.stats().let { "produced=" + it.produced + " inferred=" + it.inferred + " rendered=" + it.rendered + " refused=" + it.refused }),
      20f, 30f, Paint().apply { color = Color.CYAN; textSize = 18f },
    )
    if (verts == null) {
      canvas.drawText(
        "no mesh: gatePassed=" + snapshot?.gatePassed + " findings=" + snapshot?.gateFindings,
        20f, 55f, Paint().apply { color = Color.RED; textSize = 16f },
      )
    }
    if (session.currentState() == ReplayState.PLAYING) postInvalidateOnAnimation()
  }

  override fun onDetachedFromWindow() {
    // Lifecycle safety: a view torn down mid-replay must not leave a daemon
    // thread producing geometry into an orphaned session.
    stopReplay()
    stopPerception()
    stopCamera()
    super.onDetachedFromWindow()
  }

  /** Bounded replay telemetry for gate evidence. Aggregate counters only. */
  fun readReplayStatsJson(): String? {
    val session = replaySession ?: return null
    val stats = session.stats()
    return "{\"state\":\"" + session.currentState().name + "\"" +
      ",\"fixtureId\":\"" + (session.currentFixtureId() ?: "") + "\"" +
      ",\"produced\":" + stats.produced +
      ",\"rendered\":" + stats.rendered +
      ",\"dropped\":" + stats.dropped +
      ",\"maxSlotDepth\":" + stats.maxSlotDepth +
      ",\"refused\":" + stats.refused + "}"
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

  /**
   * The replay draw path. Reads the freshest published snapshot and draws
   * it. Computes NO geometry: amendment D10 forbids running deformation
   * inside the draw callback, and the snapshot it consumes was produced on
   * the replay thread.
   */
  private fun drawReplay(canvas: Canvas) {
    val session = replaySession
    val bitmap = replayBitmap
    if (session == null || bitmap == null) {
      canvas.drawText("replay not started", 20f, 40f, Paint().apply { color = Color.YELLOW; textSize = 24f })
      return
    }
    val snapshot = session.consumeForRender() ?: session.slot.peek()
    val verts = snapshot?.meshVertices
    canvas.save()
    canvas.scale(min(width / RENDER_CANVAS_W, height / RENDER_CANVAS_H), min(width / RENDER_CANVAS_W, height / RENDER_CANVAS_H))
    if (verts != null) {
      canvas.drawBitmapMesh(bitmap, snapshot.meshWidth, snapshot.meshHeight, verts, 0, null, 0, Paint().apply { isAntiAlias = true })
    }
    canvas.restore()
    val stats = session.stats()
    canvas.drawText(
      session.currentState().name + "  produced=" + stats.produced + " rendered=" + stats.rendered + " dropped=" + stats.dropped,
      20f, 30f, Paint().apply { color = Color.GREEN; textSize = 22f },
    )
    // Redraw on the UI thread's own cadence -- deliberately NOT synchronised
    // to production, which is the whole point of the latest-state slot.
    if (session.currentState() == ReplayState.PLAYING) postInvalidateOnAnimation()
  }

  /**
   * The N1-E perception draw path. Reads the freshest snapshot the
   * perception session's inference thread published and draws it -- this
   * function computes nothing, runs no inference, and touches no provider
   * (amendment/mission section 23: perception stays off the UI thread).
   */
  private fun drawPerception(canvas: Canvas) {
    val session = perceptionSession
    val bitmap = perceptionBitmap
    if (session == null || bitmap == null) {
      canvas.drawText("perception not started", 20f, 40f, Paint().apply { color = Color.YELLOW; textSize = 24f })
      return
    }
    val snapshot = session.consumeForRender() ?: session.geometrySlot.peek()
    val verts = snapshot?.meshVertices
    canvas.save()
    val fitScale = min(width / RENDER_CANVAS_W, height / RENDER_CANVAS_H)
    canvas.scale(fitScale, fitScale)
    if (verts != null) {
      canvas.drawBitmapMesh(bitmap, snapshot.meshWidth, snapshot.meshHeight, verts, 0, null, 0, Paint().apply { isAntiAlias = true })
    }
    canvas.restore()
    val stats = session.stats()
    canvas.drawText(
      session.currentState().name + " produced=" + stats.produced + " inferred=" + stats.inferred +
        " refused=" + stats.refused + " rendered=" + stats.rendered,
      20f, 30f, Paint().apply { color = Color.CYAN; textSize = 20f },
    )
    canvas.drawText(
      "droppedPerception=" + stats.droppedBeforePerception + " droppedRender=" + stats.droppedBeforeRender,
      20f, 55f, Paint().apply { color = Color.CYAN; textSize = 20f },
    )
    if (verts == null) {
      canvas.drawText(
        "no mesh: gatePassed=" + snapshot?.gatePassed + " findings=" + snapshot?.gateFindings + " failure=" + snapshot?.failure +
          " scale=" + snapshot?.scale + " bounds=" + snapshot?.boundsMin + ".." + snapshot?.boundsMax,
        20f, 80f, Paint().apply { color = Color.RED; textSize = 16f },
      )
    }
    if (session.currentState() == ReplayState.PLAYING) postInvalidateOnAnimation()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (camera) {
      // The live camera feed is a CHILD view (`PreviewView`), drawn during
      // `dispatchDraw` -- painting an opaque background here would only be
      // immediately covered by it. Nothing else to do in `onDraw` for this
      // mode; the mesh overlay is drawn in `dispatchDraw`, AFTER the camera
      // child, so it composites on top rather than being drawn under it.
      return
    }
    val bg = Paint().apply { color = Color.rgb(32, 32, 36) }
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bg)

    if (perception) {
      drawPerception(canvas)
      return
    }
    if (replay) {
      drawReplay(canvas)
      return
    }
    if (!active) return
    val err = loadError
    if (err != null) {
      val p = Paint().apply { color = Color.RED; textSize = 28f }
      canvas.drawText("N1-B render error: $err", 20f, 60f, p)
      return
    }
    val bitmap = garmentBitmap
    val verts = meshVerts
    Log.d(TAG, "N1-B onDraw: viewW=$width viewH=$height bitmap=${bitmap?.let { it.width.toString()+"x"+it.height } ?: "null"} bitmapConfig=${bitmap?.config} verts=${verts?.size ?: "null"} meshW=$meshWidth meshH=$meshHeight")
    if (bitmap == null) return

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

  /**
   * `camera` mode's ONLY child is the live `PreviewView`. Drawing the mesh
   * here -- after `super.dispatchDraw` renders that child -- is what makes
   * the garment composite ON TOP of the live video instead of underneath
   * it (a `ViewGroup` draws its own `onDraw` content BEFORE its children,
   * never after, so the mesh cannot be drawn there for this mode; see
   * `onDraw`'s early return above).
   */
  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    if (camera) drawCameraOverlay(canvas)
  }
}
