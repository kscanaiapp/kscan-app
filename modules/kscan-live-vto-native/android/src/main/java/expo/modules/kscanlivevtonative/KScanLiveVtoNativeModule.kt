package expo.modules.kscanlivevtonative

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Expo bridge for the single mounted native Live view. Static capability is
 * distinct from runtime camera/tracking events and physical certification. */
class KScanLiveVtoNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KScanLiveVto")

    // Static prerequisites only. Camera and tracking are observed after Start.
    Function("getCapability") {
      val context = appContext.reactContext
      val modelBytes = try {
        context?.assets?.open(LiveVtoMediaPipePoseProvider.MODEL_ASSET_PATH)?.use { it.readBytes() }
      } catch (_: Throwable) { null }
      // Construct the same software Canvas/mesh primitive the native view uses.
      val rendererAvailable = try {
        val target = android.graphics.Bitmap.createBitmap(2, 2, android.graphics.Bitmap.Config.ARGB_8888)
        val texture = android.graphics.Bitmap.createBitmap(2, 2, android.graphics.Bitmap.Config.ARGB_8888)
        texture.eraseColor(android.graphics.Color.WHITE)
        android.graphics.Canvas(target).drawBitmapMesh(texture, 1, 1, floatArrayOf(0f, 0f, 2f, 0f, 0f, 2f, 2f, 2f), 0, null, 0, null)
        val painted = target.getPixel(0, 0) != 0
        target.recycle(); texture.recycle()
        painted
      } catch (_: Throwable) { false }
      LiveVtoCapabilityStages.evaluate(
        LiveVtoCapabilityStages.Inputs(
          sdkInt = android.os.Build.VERSION.SDK_INT,
          frontCameraPresent = context?.packageManager
            ?.hasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA_FRONT) == true,
          modelAssetPresent = modelBytes != null,
          modelIntegrityValid = modelBytes?.let { LiveVtoModelIntegrity.isApproved(it) } == true,
          rendererAvailable = rendererAvailable,
          cameraPermissionGranted = context != null &&
            androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED,
        ),
        RUNTIME_VERSION,
      )
    }

    // N1-G: capturePersonFrame()/capturePreview() -- the two ALREADY-GOVERNED
    // application-contract commands (types/vtoLive.ts's LIVE_VTO_COMMANDS;
    // services/vto/liveVtoNativeModule.ts's LiveVtoNativeModule interface;
    // services/vto/vtoLiveSession.ts's already-tested capture() calls
    // exactly these two names on the MODULE, not a view ref). Declared at
    // module level, unlike the diagnostic Props/AsyncFunctions in the View
    // block below, because that is how the real application contract calls
    // them. Each reaches whichever LiveVtoTestRenderView instance is
    // currently mounted via LiveVtoTestRenderView.currentInstance() --
    // exactly one Live VTO view exists at a time by construction (mission
    // section 14). Returns a LiveVtoCapturedFrame-shaped map: a captureId
    // and a local file:// URI, never pixel bytes across the bridge (mission
    // section 6/17) -- see LiveVtoTestRenderView.kt's own capture methods
    // for the clean-frame vs. composited-frame source distinction.
    AsyncFunction("capturePersonFrame") {
      val view = LiveVtoTestRenderView.currentInstance()
        ?: throw CodedException("NO_ACTIVE_SESSION", "capturePersonFrame called with no active Live VTO view", null)
      val result = runOnMainThreadBlocking { view.captureCleanFrame() }
        ?: throw CodedException("CAPTURE_UNAVAILABLE", "no clean person frame is currently available to capture", null)
      mapOf(
        "captureId" to result.captureId,
        "kind" to result.kind,
        "localUri" to result.localUri,
        "width" to result.width,
        "height" to result.height,
      )
    }

    AsyncFunction("capturePreview") {
      val view = LiveVtoTestRenderView.currentInstance()
        ?: throw CodedException("NO_ACTIVE_SESSION", "capturePreview called with no active Live VTO view", null)
      val result = runOnMainThreadBlocking { view.captureCompositedFrame() }
        ?: throw CodedException("CAPTURE_UNAVAILABLE", "no composited preview is currently available to capture", null)
      mapOf(
        "captureId" to result.captureId,
        "kind" to result.kind,
        "localUri" to result.localUri,
        "width" to result.width,
        "height" to result.height,
      )
    }

    // Part B (2026-09-06): the session lifecycle commands
    // types/vtoLive.ts's LIVE_VTO_COMMANDS already governs and
    // services/vto/vtoLiveSession.ts's LiveVtoSessionController (already
    // implemented, already tested) already calls -- start/pause/resume/stop/
    // loadGarment/switchGarment/dispose. Declared SYNCHRONOUS (`Function`,
    // not `AsyncFunction`) to match the real TS interface exactly: per
    // services/vto/liveVtoNativeModule.ts's own LiveVtoNativeModule type and
    // vtoLiveSession.ts's sendLiveVtoCommand doc comment, these are
    // "fire-and-forget by contract: the runtime reports what actually
    // happened through events, not return values." A rejected command (an
    // invalid transition, or no active view) throws; the JS controller
    // already wraps every one of these calls in sendLiveVtoCommand's
    // try/catch and turns a throw into the correct bounded error state
    // itself -- this module does not need to pre-guess which JS state that
    // becomes.
    Events("liveVtoEvent")

    fun currentViewOrThrow(): LiveVtoTestRenderView {
      val view = LiveVtoTestRenderView.currentInstance()
        ?: throw CodedException("NO_ACTIVE_SESSION", "session command called with no active Live VTO view", null)
      // Idempotent: (re)armed on every command so a view that outlives a
      // previous module instance (should not happen in practice, since both
      // are Expo-managed, but costs nothing to keep current) always emits
      // through the live Module, never a stale closure.
      view.sessionEventSink = { type, payload ->
        sendEvent("liveVtoEvent", mapOf("type" to type, "timestamp" to System.currentTimeMillis(), "payload" to payload))
      }
      return view
    }

    fun garmentDescriptorOrThrow(raw: Map<String, Any?>?): LiveVtoGarmentDescriptor =
      LiveVtoGarmentDescriptor.fromBridgeMap(raw)
        ?: throw CodedException("GARMENT_UNSUPPORTED", "loadGarment/switchGarment descriptor is missing a required field or has an unsupported templateFamily", null)

    // `runOnMainThreadBlocking` on every one of these is load-bearing, not
    // stylistic: a plain synchronous `Function` (unlike a View `Prop`
    // setter, which Expo already guarantees runs on the UI thread, and
    // unlike `AsyncFunction`, which has its own `.runOnQueue(Queues.MAIN)`
    // -- a modifier the sync `Function` builder does NOT expose, confirmed
    // by a real Kotlin "Unresolved reference" compile error when this was
    // tried here) is dispatched on the JS bridge's own background thread by
    // default. `startSession()` constructs a `PreviewView`/binds CameraX,
    // both of which throw IllegalStateException("must be called from the
    // main thread") off that thread -- confirmed via a real on-device
    // stack trace during Part B verification, not assumed. Every command
    // that can reach `startCamera()`/`stopCamera()` (start/pause/resume/
    // stop/loadGarment/switchGarment/dispose) needs the SAME guarantee,
    // since any of them can run while a camera session is active.
    Function("start") {
      runOnMainThreadBlocking {
        if (!currentViewOrThrow().startSession()) {
          throw CodedException("RUNTIME_INITIALIZATION_FAILED", "start() is not valid from the session's current state", null)
        }
      }
    }

    Function("pause") {
      runOnMainThreadBlocking {
        if (!currentViewOrThrow().pauseSession()) {
          throw CodedException("INVALID_STATE", "pause() is only valid while the session is RUNNING", null)
        }
      }
    }

    Function("resume") {
      runOnMainThreadBlocking {
        if (!currentViewOrThrow().resumeSession()) {
          throw CodedException("INVALID_STATE", "resume() is only valid while the session is PAUSED", null)
        }
      }
    }

    Function("stop") {
      runOnMainThreadBlocking {
        if (!currentViewOrThrow().stopSession()) {
          throw CodedException("INVALID_STATE", "stop() is refused after dispose()", null)
        }
      }
    }

    Function("loadGarment") { descriptor: Map<String, Any?>? ->
      val parsed = garmentDescriptorOrThrow(descriptor)
      runOnMainThreadBlocking {
        if (!currentViewOrThrow().loadGarmentSession(parsed)) {
          throw CodedException("GARMENT_UNSUPPORTED", "loadGarment() is not valid from the session's current state", null)
        }
      }
    }

    Function("switchGarment") { descriptor: Map<String, Any?>? ->
      val parsed = garmentDescriptorOrThrow(descriptor)
      runOnMainThreadBlocking {
        if (!currentViewOrThrow().switchGarmentSession(parsed)) {
          throw CodedException("GARMENT_UNSUPPORTED", "switchGarment() is only valid while the session is RUNNING, PAUSED or READY", null)
        }
      }
    }

    Function("dispose") {
      // Idempotent and never throws (matches types/vtoLive.ts's
      // LiveVtoSessionController.dispose() contract exactly): calling
      // dispose on a view that never started a session, or twice, is a
      // safe no-op, not an error.
      runOnMainThreadBlocking {
        LiveVtoTestRenderView.currentInstance()?.disposeSession()
        Unit
      }
    }

    // N1-B: diagnostic-only native view, not part of the P3-C application
    // contract. Renders one bundled governed .ksgarment fixture through a
    // canned BodyFrame -- inert until `active` is set true. See
    // LiveVtoTestRenderView.kt and docs/vto-live-native-runtime-n1.md.
    View(LiveVtoTestRenderView::class) {
      Prop("active") { view: LiveVtoTestRenderView, active: Boolean -> view.active = active }

      // DIAGNOSTIC ONLY. Returns a single geometry snapshot on demand, as
      // a JSON string, for gate evidence. This is deliberately NOT a
      // per-frame channel: amendment D24 forbids high-frequency geometry
      // (and any frame/landmark payload) crossing the bridge, and N1-D's
      // replay pipeline emits bounded state events instead. Guarded by a
      // one-shot rate limiter so it cannot be turned into a frame pump by
      // a caller polling it.
      AsyncFunction("getGeometrySnapshotJson") { view: LiveVtoTestRenderView ->
        view.readDiagnosticSnapshotJson()
      }

      // N1-D. JS issues bounded commands only -- start/stop replay. It never
      // receives a frame, a BodyFrame, or per-frame geometry: the replay
      // pipeline stays entirely native once started (mission section 16).
      Prop("replay") { view: LiveVtoTestRenderView, replay: Boolean -> view.replay = replay }

      // Aggregate counters for gate evidence. Bounded: produced/rendered/
      // dropped/depth and the session state, never anything per frame.
      AsyncFunction("getReplayStatsJson") { view: LiveVtoTestRenderView ->
        view.readReplayStatsJson()
      }

      // N1-E. JS issues one bounded command -- start/stop real local
      // perception. It NEVER receives a frame, a raw landmark array, or a
      // BodyFrame: real MediaPipe inference, the BodyFrame adapter, and
      // the geometry compute all run natively, off the UI thread (mission
      // sections 6, 23, 26).
      Prop("perception") { view: LiveVtoTestRenderView, perception: Boolean -> view.perception = perception }

      // Aggregate perception counters only -- produced/submitted/inferred/
      // refused/rendered/dropped(x2)/depth(x2) and the session state.
      // Never a landmark, never a BodyFrame, never a frame.
      AsyncFunction("getPerceptionStatsJson") { view: LiveVtoTestRenderView ->
        view.readPerceptionStatsJson()
      }

      // N1-F. JS issues one bounded command -- start/stop the LIVE front
      // camera. Exactly like `perception`, it never receives a frame, a
      // raw camera buffer, or a BodyFrame: CameraX, the SAME real MediaPipe
      // inference, the SAME BodyFrame adapter, and the SAME geometry
      // compute all run natively, off the UI thread (mission sections 7,
      // 23, 26).
      Prop("camera") { view: LiveVtoTestRenderView, camera: Boolean -> view.camera = camera }

      // Aggregate camera+perception counters only -- the camera boundary's
      // own produced/dropped/consumed counts alongside the same bounded
      // perception counters `getPerceptionStatsJson` exposes. Never a
      // frame, never a landmark, never a BodyFrame.
      AsyncFunction("getCameraStatsJson") { view: LiveVtoTestRenderView ->
        view.readCameraStatsJson()
      }
    }
  }

  companion object {
    private const val RUNTIME_VERSION = "build35-live-v1"
  }
}

/**
 * Runs [block] on the main thread and blocks the calling thread until it
 * completes, re-throwing whatever [block] threw on the CALLER's thread --
 * the synchronous, throwing-or-not semantics `sendLiveVtoCommand` in
 * services/vto/vtoLiveSession.ts depends on. The Expo `Function` (sync)
 * builder has no `.runOnQueue` modifier (`AsyncFunction` does; a compile
 * error confirmed the asymmetry) and is otherwise dispatched on the JS
 * bridge's own background thread, off which UI-thread-only work
 * (constructing `PreviewView`, binding CameraX) throws. A no-op fast path
 * when already on the main thread avoids a pointless post+await when a
 * caller is itself already there.
 */
private fun <T> runOnMainThreadBlocking(block: () -> T): T {
  if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return block()
  val latch = java.util.concurrent.CountDownLatch(1)
  var outcome: Result<T>? = null
  android.os.Handler(android.os.Looper.getMainLooper()).post {
    outcome = try {
      Result.success(block())
    } catch (t: Throwable) {
      Result.failure(t)
    }
    latch.countDown()
  }
  latch.await()
  return outcome!!.getOrThrow()
}
