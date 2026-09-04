// LiveVTOView.swift
//
// STATUS: unbuilt scaffolding — see native/README.md and
// LiveVTOModule.swift's header. This is the ExpoView subclass the native
// camera/pose/segmentation/deformation/render pipeline will eventually
// own end-to-end (Section 10: "The native view owns the camera ->
// inference -> state -> rendering pipeline"). Every subsystem is a TODO.

import ExpoModulesCore
import AVFoundation

class LiveVTOView: ExpoView {
  // TODO(P1-B1): AVCaptureSession + preview layer.
  // private var captureSession: AVCaptureSession?

  // TODO(P1-B2): pose provider adapter producing packages/live-vto-contract's
  // BodyFrame shape. First implementation target: Vision framework's
  // VNDetectHumanBodyPoseRequest (on-device, no network) or, if evidence
  // shows a MediaPipe Pose Landmarker Task build integrates more reliably
  // via Expo Modules, that instead — Section P1-B2: "Do not hard-bind
  // downstream code to [a specific provider's] IDs," so either choice
  // must map into BodyFrame at this layer and nowhere deeper.
  // private var poseAdapter: PoseAdapter?

  // TODO(P1-E3 / P2-E): segmentation + compositor.
  // TODO(P1-E2 / P2-C2): garment mesh + deformation (port
  // affineMlsDeformation.ts's math, or the real Metal/Core Animation
  // equivalent, once a device proves the JS reference implementation's
  // approach is the right one to keep — see Section 41).
  // TODO(P1-C2): bounded local capture ring buffer.

  func start() {
    // TODO: see LiveVTOModule.swift's AsyncFunction("start") TODO.
  }

  func stop() {
    // TODO
  }

  func pause() {
    // TODO
  }

  func resume() {
    // TODO
  }

  func loadGarment(garmentJson: String, ksgarmentUri: String) {
    // TODO
  }

  func switchGarment(garmentJson: String, ksgarmentUri: String) {
    // TODO
  }

  func capture() {
    // TODO
  }

  func dispose() {
    // TODO
  }
}
