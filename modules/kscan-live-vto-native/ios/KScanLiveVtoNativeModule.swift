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
/// Android -- not the full aspirational `LiveVtoNativeModule` TS interface
/// (`start`/`pause`/`resume`/`stop`/`loadGarment`/`switchGarment`/
/// `requestPhotorealCapture`/`dispose` remain unimplemented on both
/// platforms). N1-G (2026-09-06) implements the two capture commands
/// (`capturePersonFrame`/`capturePreview`) as MODULE-level functions,
/// matching how `services/vto/vtoLiveSession.ts` already calls them on the
/// real `LiveVtoNativeModule` interface (no view ref involved) -- see
/// `LiveVtoRenderView.capturePersonFrame()`/`.capturePreview()` for the
/// clean-frame-vs-composited-frame distinction.
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

    // N1-G: capturePersonFrame()/capturePreview() -- the two ALREADY-GOVERNED
    // application-contract commands (types/vtoLive.ts's LIVE_VTO_COMMANDS;
    // services/vto/liveVtoNativeModule.ts's LiveVtoNativeModule interface;
    // services/vto/vtoLiveSession.ts's already-tested capture() calls
    // exactly these two names on the MODULE, not a view ref). Declared at
    // module level, unlike the diagnostic Props/AsyncFunctions in the View
    // block below, because that is how the real application contract calls
    // them. Returns a LiveVtoCapturedFrame-shaped dictionary: a captureId
    // and a local file:// URI, never pixel bytes across the bridge -- see
    // LiveVtoRenderView.swift's own capture methods for the clean-frame vs.
    // composited-frame source distinction.
    AsyncFunction("capturePersonFrame") { () throws -> [String: Any] in
      try LiveVtoRenderView.capturePersonFrame()
    }

    AsyncFunction("capturePreview") { () throws -> [String: Any] in
      try LiveVtoRenderView.capturePreview()
    }

    // Part B (2026-09-06): the session lifecycle commands
    // types/vtoLive.ts's LIVE_VTO_COMMANDS already governs and
    // services/vto/vtoLiveSession.ts's LiveVtoSessionController (already
    // implemented, already tested) already calls -- start/pause/resume/stop/
    // loadGarment/switchGarment/dispose. Declared SYNCHRONOUS (`Function`,
    // not `AsyncFunction`) to match the real TS interface exactly: per
    // vtoLiveSession.ts's sendLiveVtoCommand doc comment, these are
    // "fire-and-forget by contract: the runtime reports what actually
    // happened through events, not return values." A rejected command
    // throws; the JS controller already wraps every one of these calls in
    // sendLiveVtoCommand's try/catch and turns a throw into the correct
    // bounded error state itself.
    Events("liveVtoEvent")

    Function("start") { () throws -> Void in
      guard try currentSessionView().startSession() else {
        throw LiveVtoSessionCommandError.rejected("start() is not valid from the session's current state")
      }
    }

    Function("pause") { () throws -> Void in
      guard try currentSessionView().pauseSession() else {
        throw LiveVtoSessionCommandError.rejected("pause() is only valid while the session is RUNNING")
      }
    }

    Function("resume") { () throws -> Void in
      guard try currentSessionView().resumeSession() else {
        throw LiveVtoSessionCommandError.rejected("resume() is only valid while the session is PAUSED")
      }
    }

    Function("stop") { () throws -> Void in
      guard try currentSessionView().stopSession() else {
        throw LiveVtoSessionCommandError.rejected("stop() is refused after dispose()")
      }
    }

    Function("loadGarment") { (descriptor: [String: Any]?) throws -> Void in
      guard let parsed = LiveVtoGarmentDescriptor.fromBridgeMap(descriptor) else {
        throw LiveVtoSessionCommandError.rejected("loadGarment descriptor is missing a required field or has an unsupported templateFamily")
      }
      guard try currentSessionView().loadGarmentSession(parsed) else {
        throw LiveVtoSessionCommandError.rejected("loadGarment() is not valid from the session's current state")
      }
    }

    Function("switchGarment") { (descriptor: [String: Any]?) throws -> Void in
      guard let parsed = LiveVtoGarmentDescriptor.fromBridgeMap(descriptor) else {
        throw LiveVtoSessionCommandError.rejected("switchGarment descriptor is missing a required field or has an unsupported templateFamily")
      }
      guard try currentSessionView().switchGarmentSession(parsed) else {
        throw LiveVtoSessionCommandError.rejected("switchGarment() is only valid while the session is RUNNING, PAUSED or READY")
      }
    }

    Function("dispose") { () -> Void in
      // Idempotent and never throws (matches types/vtoLive.ts's
      // LiveVtoSessionController.dispose() contract exactly): calling
      // dispose on a view that never started a session, or twice, is a
      // safe no-op, not an error.
      LiveVtoRenderView.disposeCurrentSession()
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

  /// Resolves the currently-mounted `LiveVtoRenderView` (mirrors
  /// `capturePersonFrame`'s own `currentInstance` lookup) and (re)arms its
  /// session event sink to emit through THIS module instance. Idempotent --
  /// safe to call on every command, matches Android's `currentViewOrThrow()`.
  private func currentSessionView() throws -> LiveVtoRenderView {
    try LiveVtoRenderView.currentSessionView { [weak self] type, payload in
      self?.sendEvent("liveVtoEvent", ["type": type, "timestamp": Date().timeIntervalSince1970 * 1000, "payload": payload])
    }
  }
}
