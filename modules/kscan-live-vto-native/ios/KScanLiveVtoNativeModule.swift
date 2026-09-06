import ExpoModulesCore

/// iOS catch-up counterpart to Android's `KScanLiveVtoNativeModule.kt`.
///
/// Registers as "KScanLiveVto" -- this exact string is
/// `constants/featureFlags.ts`'s `LIVE_VTO_NATIVE_MODULE_NAME`, the value
/// `services/vto/liveVtoNativeModule.ts`'s `requireOptionalNativeModule()`
/// looks up. Do not rename either side independently.
///
/// SCOPE. This reproduces N1's ACTUAL shipped diagnostic surface -- the one
/// `RuntimeBoundaryTest.theBridgeSurfaceIsPinned` mechanically pins on
/// Android -- not the aspirational full `LiveVtoNativeModule` TS interface
/// (`start`/`pause`/`resume`/`stop`/`loadGarment`/`switchGarment`/
/// `capturePersonFrame`/`capturePreview`/`requestPhotorealCapture`/
/// `dispose`). Neither platform has implemented that command surface yet --
/// it is bound up with front-camera work, which is explicitly out of scope
/// for this catch-up lane (see `docs/vto-live-bridge-contract.md`,
/// "SHARED CONTRACT QUESTION" section). Building it here would be
/// leapfrogging Android, not catching up to it.
///
/// `getCapability()` is synchronous (`Function`, not `AsyncFunction`) for the
/// same reason as Android: the merged application adapter
/// (`describeLiveVtoNativeCapability` in `liveVtoNativeModule.ts`) calls it
/// without awaiting -- an `AsyncFunction` here would hand JS a Promise where
/// a plain object is expected and silently fail every capability check.
///
/// Field names are `capable`/`runtimeReady`/`runtimeVersion` -- the actual
/// merged `LiveVtoNativeSelfCheck` shape, matching Android exactly. Both are
/// `false` at this gate: this stage proves registration only, and neither
/// device eligibility nor runtime initialization has been implemented yet.
/// Claiming `capable: true` here would be exactly the "registration is not
/// capability" mistake Android's own module comment warns against.
public class KScanLiveVtoNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KScanLiveVto")

    Function("getCapability") { () -> [String: Any?] in
      [
        "capable": false,
        "runtimeReady": false,
        "runtimeVersion": Self.runtimeVersion,
      ]
    }

    // Diagnostic-only native view, not part of the P3-C application contract
    // -- reproduces exactly Android's `View(LiveVtoTestRenderView::class)`
    // surface. Renders one bundled governed .ksgarment fixture through a
    // canned BodyFrame -- inert until `active` is set true.
    View(LiveVtoRenderView.self) {
      Prop("active") { (view: LiveVtoRenderView, active: Bool) in
        view.active = active
      }

      // DIAGNOSTIC ONLY. Returns a single geometry snapshot on demand, as a
      // JSON string, for gate evidence. Deliberately NOT a per-frame
      // channel -- no frame/landmark payload ever crosses the bridge.
      // Guarded by a one-shot rate limiter (see `LiveVtoRenderView
      // .readDiagnosticSnapshotJson`) so it cannot be turned into a frame
      // pump by a caller polling it.
      AsyncFunction("getGeometrySnapshotJson") { (view: LiveVtoRenderView) -> String? in
        view.readDiagnosticSnapshotJson()
      }

      // JS issues bounded commands only -- start/stop replay. It never
      // receives a frame, a BodyFrame, or per-frame geometry: the replay
      // pipeline stays entirely native once started.
      Prop("replay") { (view: LiveVtoRenderView, replay: Bool) in
        view.replay = replay
      }

      // Aggregate counters for gate evidence. Bounded: produced/rendered/
      // dropped/depth and the session state, never anything per frame.
      AsyncFunction("getReplayStatsJson") { (view: LiveVtoRenderView) -> String? in
        view.readReplayStatsJson()
      }

      // JS issues one bounded command -- start/stop real local perception.
      // It NEVER receives a frame, a raw landmark array, or a BodyFrame:
      // real MediaPipe inference, the BodyFrame adapter, and the geometry
      // compute all run natively, off the main thread.
      Prop("perception") { (view: LiveVtoRenderView, perception: Bool) in
        view.perception = perception
      }

      // Aggregate perception counters only -- produced/submitted/inferred/
      // refused/rendered/dropped(x2)/depth(x2) and the session state. Never
      // a landmark, never a BodyFrame, never a frame.
      AsyncFunction("getPerceptionStatsJson") { (view: LiveVtoRenderView) -> String? in
        view.readPerceptionStatsJson()
      }

      // N1-F (iOS parity). JS issues one bounded command -- start/stop the
      // LIVE front camera. Exactly like `perception`, it never receives a
      // frame, a raw camera buffer, or a BodyFrame: AVFoundation, the SAME
      // real MediaPipe inference, the SAME BodyFrame adapter, and the SAME
      // geometry compute all run natively, off the main thread.
      Prop("camera") { (view: LiveVtoRenderView, camera: Bool) in
        view.camera = camera
      }

      // Aggregate camera+perception counters only -- the camera boundary's
      // own produced/dropped/consumed counts alongside the same bounded
      // perception counters `getPerceptionStatsJson` exposes. Never a
      // frame, never a landmark, never a BodyFrame.
      AsyncFunction("getCameraStatsJson") { (view: LiveVtoRenderView) -> String? in
        view.readCameraStatsJson()
      }
    }
  }

  /// Distinguishable from Android's "n1-a" on purpose -- this is a free-text
  /// diagnostic field, not part of any pinned contract, so a captured log
  /// can tell which platform's module actually answered.
  private static let runtimeVersion = "n1-a-ios"
}
