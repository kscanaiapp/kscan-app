package expo.modules.kscanlivevtonative

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
