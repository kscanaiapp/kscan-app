// LiveVTOModule.swift
//
// Expo Modules native-view module definition — Section 10.
//
// STATUS: unbuilt scaffolding. Never compiled in this session (no Xcode /
// macOS toolchain available in this cloud sandbox — see native/README.md).
// Written against the documented Expo Modules API shape as of Expo SDK 54
// (matching this repo's existing `expo ~54.0.35` dependency, recorded in
// docs/source-authority.md) but NOT verified against a real compiler.
//
// The command/event names below must stay byte-identical to
// packages/live-vto-contract/src/nativeView.ts's LiveVTOCommands /
// LiveVTOEventName — that TypeScript file is the source of truth; this
// file mirrors it, not the other way around.

import ExpoModulesCore

public class LiveVTOModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveVTO")

    // Section 10: "High-level events" — narrow, low-frequency, no pixel
    // data, no raw landmarks, no raw masks. See nativeView.ts's
    // FORBIDDEN_EVENT_PAYLOAD_KEYS for the enforced boundary on the JS side;
    // this native side must never construct a payload containing any of
    // those keys either.
    Events(
      "ready",
      "trackingAcquired",
      "trackingWeak",
      "trackingLost",
      "trackingRecovered",
      "garmentLoaded",
      "captureReady",
      "qualityChanged",
      "thermalChanged",
      "privacyState",
      "fatalError"
    )

    View(LiveVTOView.self) {
      // Section 10 command surface. Each one below is a TODO — this
      // module currently does nothing but exist as a stub other Expo
      // Modules API scaffolding (view registration, event names) can be
      // built and iterated against once a real device session starts.

      AsyncFunction("start") { (view: LiveVTOView) in
        // TODO(P1-B1): request camera permission, start AVCaptureSession,
        // begin the pose (P1-B2) + guidance (P1-B3) pipeline. Emit
        // "ready" once the first stable frame arrives.
        view.start()
      }

      AsyncFunction("stop") { (view: LiveVTOView) in
        // TODO(P1-B1): tear down AVCaptureSession cleanly (handle
        // background/foreground/interruption per P1-B1's lifecycle list).
        view.stop()
      }

      AsyncFunction("pause") { (view: LiveVTOView) in
        view.pause()
      }

      AsyncFunction("resume") { (view: LiveVTOView) in
        view.resume()
      }

      AsyncFunction("loadGarment") { (view: LiveVTOView, garmentJson: String, ksgarmentUri: String) in
        // TODO(P1-D4/P1-E1): parse + validate the .ksgarment manifest at
        // ksgarmentUri (mirror garment-contract's validateKsgarmentManifest
        // logic), load texture + alpha, build the initial mesh via
        // gridVertices()-equivalent native code, attach using the
        // affine-MLS control-point deformation ported from
        // asset-pipeline/src/affineMlsDeformation.ts. Emit "garmentLoaded".
        view.loadGarment(garmentJson: garmentJson, ksgarmentUri: ksgarmentUri)
      }

      AsyncFunction("switchGarment") { (view: LiveVTOView, garmentJson: String, ksgarmentUri: String) in
        // TODO(P2-H): swap garment state only — camera/pose/calibration
        // must NOT restart. Preload/cache per Section P2-H.
        view.switchGarment(garmentJson: garmentJson, ksgarmentUri: ksgarmentUri)
      }

      AsyncFunction("capture") { (view: LiveVTOView) in
        // TODO(P1-C2): write into the bounded local ring buffer, emit
        // "captureReady" with a captureId — never a pixel payload.
        view.capture()
      }

      AsyncFunction("dispose") { (view: LiveVTOView) in
        // TODO: release camera/session/renderer resources, clear the
        // capture replay buffer (P1-C2: "cleared when unnecessary").
        view.dispose()
      }
    }
  }
}
