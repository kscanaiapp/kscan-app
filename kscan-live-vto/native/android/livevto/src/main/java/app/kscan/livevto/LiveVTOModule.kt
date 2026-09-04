// LiveVTOModule.kt
//
// Expo Modules native-view module definition (Android mirror of
// ios/LiveVTOModule.swift). Section 11: "Do not force iOS and Android to
// advance in lockstep during early R&D... Android follows after the
// critical Phase 1 pipeline is demonstrated [on iOS]." This file exists
// so the contract surface is visibly platform-neutral from day one, per
// Section 11's "contracts must remain platform-neutral" — it is NOT
// evidence that Android implementation work has started.
//
// STATUS: unbuilt scaffolding. Never compiled in this session (no
// Android SDK/Gradle build was attempted here — see native/README.md).

package app.kscan.livevto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher

class LiveVTOModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LiveVTO")

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

    View(LiveVTOView::class) {
      AsyncFunction("start") { view: LiveVTOView ->
        // TODO(P1-B1): CameraX session start. See ios/LiveVTOModule.swift's
        // matching TODO for the shared behavioral contract.
        view.start()
      }

      AsyncFunction("stop") { view: LiveVTOView ->
        view.stop()
      }

      AsyncFunction("pause") { view: LiveVTOView ->
        view.pause()
      }

      AsyncFunction("resume") { view: LiveVTOView ->
        view.resume()
      }

      AsyncFunction("loadGarment") { view: LiveVTOView, garmentJson: String, ksgarmentUri: String ->
        view.loadGarment(garmentJson, ksgarmentUri)
      }

      AsyncFunction("switchGarment") { view: LiveVTOView, garmentJson: String, ksgarmentUri: String ->
        view.switchGarment(garmentJson, ksgarmentUri)
      }

      AsyncFunction("capture") { view: LiveVTOView ->
        view.capture()
      }

      AsyncFunction("dispose") { view: LiveVTOView ->
        view.dispose()
      }
    }
  }
}
