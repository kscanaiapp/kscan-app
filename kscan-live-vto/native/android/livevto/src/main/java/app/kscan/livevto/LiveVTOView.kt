// LiveVTOView.kt — STATUS: unbuilt scaffolding, see native/README.md and
// LiveVTOModule.kt's header. Android mirror of ios/LiveVTOView.swift.

package app.kscan.livevto

import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class LiveVTOView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // TODO(P1-B1): CameraX ProcessCameraProvider + PreviewView.
  // TODO(P1-B2): pose provider adapter -> BodyFrame. First implementation
  // target: MediaPipe Pose Landmarker Task (Android has no first-party
  // equivalent to iOS's Vision body-pose API), mapped into BodyFrame at
  // this layer only — see the matching Swift file's Section P1-B2 note.
  // TODO(P1-E3 / P2-E): segmentation + compositor.
  // TODO(P1-E2 / P2-C2): garment mesh + deformation.
  // TODO(P1-C2): bounded local capture ring buffer.

  fun start() {
    // TODO
  }

  fun stop() {
    // TODO
  }

  fun pause() {
    // TODO
  }

  fun resume() {
    // TODO
  }

  fun loadGarment(garmentJson: String, ksgarmentUri: String) {
    // TODO
  }

  fun switchGarment(garmentJson: String, ksgarmentUri: String) {
    // TODO
  }

  fun capture() {
    // TODO
  }

  fun dispose() {
    // TODO
  }
}
