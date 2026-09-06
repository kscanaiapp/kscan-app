package expo.modules.kscanlivevtonative

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * N1-A: scaffold + registration only.
 *
 * Registers as "KScanLiveVto" -- this exact string is
 * constants/featureFlags.ts's LIVE_VTO_NATIVE_MODULE_NAME, the value
 * services/vto/liveVtoNativeModule.ts's requireOptionalNativeModule() looks
 * up. Do not rename either side independently.
 *
 * getCapability() is synchronous (Function, not AsyncFunction) because the
 * merged application adapter calls it without awaiting
 * (describeLiveVtoNativeCapability in liveVtoNativeModule.ts) -- an
 * AsyncFunction here would hand JS a Promise where a plain object is
 * expected and silently fail every capability check.
 *
 * Field names are `capable`/`runtimeReady`/`runtimeVersion` -- the actual
 * merged LiveVtoNativeSelfCheck shape in services/vto/liveVtoNativeModule.ts,
 * not the informal "moduleAvailable" example the build mission used. Both
 * are false at N1-A: this stage proves registration only, and neither device
 * eligibility nor runtime initialization has been implemented yet. Claiming
 * `capable: true` here would be exactly the "registration is not capability"
 * mistake the application module's own header comment warns against.
 *
 * No Events() yet, no commands yet -- those are declared gate by gate
 * (N1-B..N1-G) as their real implementations land, not speculatively here.
 */
class KScanLiveVtoNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KScanLiveVto")

    Function("getCapability") {
      mapOf(
        "capable" to false,
        "runtimeReady" to false,
        "runtimeVersion" to RUNTIME_VERSION
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
      val result = view.captureCleanFrame()
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
      val result = view.captureCompositedFrame()
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

    Function("start") {
      if (!currentViewOrThrow().startSession()) {
        throw CodedException("RUNTIME_INITIALIZATION_FAILED", "start() is not valid from the session's current state", null)
      }
    }

    Function("pause") {
      if (!currentViewOrThrow().pauseSession()) {
        throw CodedException("INVALID_STATE", "pause() is only valid while the session is RUNNING", null)
      }
    }

    Function("resume") {
      if (!currentViewOrThrow().resumeSession()) {
        throw CodedException("INVALID_STATE", "resume() is only valid while the session is PAUSED", null)
      }
    }

    Function("stop") {
      if (!currentViewOrThrow().stopSession()) {
        throw CodedException("INVALID_STATE", "stop() is refused after dispose()", null)
      }
    }

    Function("loadGarment") { descriptor: Map<String, Any?>? ->
      val parsed = garmentDescriptorOrThrow(descriptor)
      if (!currentViewOrThrow().loadGarmentSession(parsed)) {
        throw CodedException("GARMENT_UNSUPPORTED", "loadGarment() is not valid from the session's current state", null)
      }
    }

    Function("switchGarment") { descriptor: Map<String, Any?>? ->
      val parsed = garmentDescriptorOrThrow(descriptor)
      if (!currentViewOrThrow().switchGarmentSession(parsed)) {
        throw CodedException("GARMENT_UNSUPPORTED", "switchGarment() is only valid while the session is RUNNING, PAUSED or READY", null)
      }
    }

    Function("dispose") {
      // Idempotent and never throws (matches types/vtoLive.ts's
      // LiveVtoSessionController.dispose() contract exactly): calling
      // dispose on a view that never started a session, or twice, is a
      // safe no-op, not an error.
      LiveVtoTestRenderView.currentInstance()?.disposeSession()
      Unit
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
    private const val RUNTIME_VERSION = "n1-a"
  }
}
