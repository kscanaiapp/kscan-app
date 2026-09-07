import Foundation
import AVFoundation
import UIKit
import os.log

private let cameraLog = OSLog(subsystem: "com.kscanai.app.livevto", category: "camera")

public enum CameraControllerState: String {
  case idle = "IDLE"
  case starting = "STARTING"
  case running = "RUNNING"
  case permissionDenied = "PERMISSION_DENIED"
  case error = "ERROR"
  case stopped = "STOPPED"
}

/// N1-F (iOS parity): wires AVFoundation (`AVCaptureVideoPreviewLayer` for
/// display + `AVCaptureVideoDataOutput` for perception input, front camera)
/// into the EXISTING native runtime (mission section 7). Structural
/// counterpart of Android's `LiveVtoCameraController.kt`. Owns exactly the
/// camera lifecycle and nothing downstream of it -- no landmark, no
/// BodyFrame, no geometry, no drawing.
///
/// Permission (mission section 16): this class checks
/// `AVCaptureDevice.authorizationStatus(for: .video)` itself and fails
/// closed to `.permissionDenied` rather than letting `AVCaptureSession`
/// throw/no-op silently if permission isn't granted. It does not REQUEST
/// the permission -- the JS-side capability/permission flow already owns
/// that UX; this is the native-side fail-closed backstop for whatever
/// state the OS is actually in when `start()` is called, including a
/// mid-session revocation on the next attempted (re)start.
public final class LiveVtoCameraController: NSObject {
  /// Camera -> perception-producer boundary. Bounded: at most one pending
  /// frame. Reuses the SAME `LatestStateSlot` this platform's replay/
  /// perception sessions already use -- not a new design per boundary.
  public let frameSlot = LatestStateSlot<PerceptionInputFrame>()

  public private(set) var state: CameraControllerState = .idle
  private let onStateChanged: (CameraControllerState, String?) -> Void

  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "kscan-live-vto-camera-session")
  private let analysisQueue = DispatchQueue(label: "kscan-live-vto-camera-analysis")

  public init(previewLayer: AVCaptureVideoPreviewLayer, onStateChanged: @escaping (CameraControllerState, String?) -> Void = { _, _ in }) {
    self.onStateChanged = onStateChanged
    super.init()
    previewLayer.session = session
  }

  public func start() {
    guard state != .starting, state != .running else { return }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      transition(.permissionDenied, "AVCaptureDevice authorization is not .authorized")
      return
    }
    transition(.starting, nil)
    sessionQueue.async { [weak self] in self?.configureAndStart() }
  }

  private func configureAndStart() {
    session.beginConfiguration()
    defer { session.commitConfiguration() }

    // This controller is the ONLY owner of `session`'s inputs/outputs across
    // start/stop -- mirroring Android's `unbindAll()`-then-rebind pattern
    // (mission: "exactly one session owns the camera"). Unlike Android's
    // process-wide `ProcessCameraProvider`, each `AVCaptureSession` instance
    // owns its own hardware claim independently, so this reset only affects
    // use cases THIS controller itself previously added.
    session.inputs.forEach { session.removeInput($0) }
    session.outputs.forEach { session.removeOutput($0) }

    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
      finishOnMain(.error, "no front camera device available")
      return
    }
    guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
      finishOnMain(.error, "could not create/add AVCaptureDeviceInput")
      return
    }
    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    // The AVFoundation equivalent of CameraX's STRATEGY_KEEP_ONLY_LATEST --
    // never let the analysis queue fall behind and build a backlog.
    output.alwaysDiscardsLateVideoFrames = true
    output.setSampleBufferDelegate(self, queue: analysisQueue)
    guard session.canAddOutput(output) else {
      finishOnMain(.error, "could not add AVCaptureVideoDataOutput")
      return
    }
    session.addOutput(output)

    if let connection = output.connection(with: .video), connection.isVideoOrientationSupported {
      // See LiveVtoCameraFrameConverter's header for why this is pinned
      // rather than read dynamically: this lane does not support landscape
      // device rotation for the Live VTO camera screen.
      connection.videoOrientation = .portrait
    }

    session.startRunning()
    finishOnMain(.running, nil)
  }

  private func finishOnMain(_ next: CameraControllerState, _ reason: String?) {
    DispatchQueue.main.async { [weak self] in self?.transition(next, reason) }
  }

  public func stop() {
    guard state != .idle, state != .stopped else { return }
    frameSlot.clear()
    sessionQueue.async { [weak self] in
      guard let self = self else { return }
      if self.session.isRunning { self.session.stopRunning() }
      self.finishOnMain(.stopped, nil)
    }
  }

  /// Called by the perception producer tick. Never blocks; never invents a frame when none has arrived.
  public func latestFrame() -> PerceptionInputFrame? { frameSlot.consume() }

  /// Always invoked on the main thread -- either directly (start/stop are
  /// called from an Expo `Prop` setter, which runs on main) or via
  /// `finishOnMain` from the session queue.
  private func transition(_ next: CameraControllerState, _ reason: String?) {
    state = next
    onStateChanged(next, reason)
  }
}

extension LiveVtoCameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
  public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let image = LiveVtoCameraFrameConverter.toImage(sampleBuffer: sampleBuffer) else {
      os_log("camera frame conversion failed", log: cameraLog, type: .error)
      return
    }
    frameSlot.publish(LiveVtoStaticImageFrame(image: image))
  }
}
