import UIKit
import ExpoModulesCore
import AVFoundation

/// A plain `UIView` whose entire backing layer IS an
/// `AVCaptureVideoPreviewLayer` -- the standard UIKit pattern for hosting a
/// live camera preview, and the iOS structural equivalent of Android's
/// `androidx.camera.view.PreviewView`.
private final class LiveVtoCameraPreviewContainerView: UIView {
  override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
  var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer } // swiftlint:disable:this force_cast
}

/// A `UIView`'s own `draw(_:)` paints into its OWN layer, which composites
/// BELOW any of its subviews/sublayers -- so the garment mesh cannot be
/// drawn in `LiveVtoRenderView`'s own `draw(_:)` for camera mode (that
/// would render UNDER the camera preview subview, not on top of it). This
/// tiny forwarding view exists ONLY to be added as a SIBLING subview
/// stacked ABOVE the camera preview container, so its own `draw(_:)`
/// composites on top of the live video -- the iOS structural equivalent of
/// Android's `dispatchDraw`-after-`super.dispatchDraw` ordering trick.
private final class LiveVtoMeshOverlayView: UIView {
  var onDraw: ((CGContext, CGRect) -> Void)?
  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    onDraw?(context, rect)
  }
}

/// Logical render canvas size -- matches the P3-A reference oracle's fixture
/// canvas (720x960), the SAME constant Android's `LiveVtoTestRenderView`
/// uses, so geometry values are directly comparable without a rescale step.
/// Drawn scaled-to-fit the real view.
private let renderCanvasW: CGFloat = 720
private let renderCanvasH: CGFloat = 960

/// At most one distinct diagnostic snapshot per second across the bridge --
/// same bound as Android's `DIAGNOSTIC_SNAPSHOT_MIN_INTERVAL_NANOS`.
private let diagnosticSnapshotMinInterval: TimeInterval = 1.0

/// iOS catch-up counterpart to Android's `LiveVtoTestRenderView`. Renders one
/// governed `.ksgarment` fixture through the ported geometry pipeline.
/// Inert until `active`/`replay`/`perception` is set true (Expo `Prop`) -- no
/// work happens on mere mount.
///
/// CORE GRAPHICS STATUS: PARITY / CONFORMANCE VEHICLE, per the mission's own
/// framing -- CPU-first Core Graphics is the conformance renderer for this
/// catch-up pass, not necessarily the final shipping Live renderer. A
/// Metal/GPU evaluation, if ever needed, happens later under shared camera
/// load.
public final class LiveVtoRenderView: ExpoView {
  private var garmentImage: CGImage?
  private var meshVerts: [Float]?
  private var meshWidth = 0
  private var meshHeight = 0
  private var loadError: String?
  private(set) var lastSnapshot: GeometrySnapshot?
  private var cachedSnapshotJson: String?
  private var cachedSnapshotAt: Date?
  private var combinedImageCache: [String: CGImage] = [:]

  public var active: Bool = false {
    didSet {
      if active && garmentImage == nil && loadError == nil { loadAndCompute() }
      setNeedsDisplay()
    }
  }

  // MARK: - Replay

  private var replaySession: LiveVtoReplaySession?
  private var replayDriver: LiveVtoReplayDriver?
  private var replayImage: CGImage?

  /// Starts/stops the native replay clock. All production and deformation
  /// runs on the driver's own queue/thread; this view only draws whatever
  /// snapshot is currently in the session's latest-state slot.
  public var replay: Bool = false {
    didSet {
      if replay { startReplay() } else { stopReplay() }
      setNeedsDisplay()
    }
  }

  private func loadFixture(_ name: String) throws -> (manifest: KsgarmentManifest, image: CGImage, textureSize: (Int, Int)) {
    let bundle = LiveVtoAssetBundle.shared
    guard
      let manifestURL = bundle.url(forResource: "manifest", withExtension: "json", subdirectory: name),
      let manifestText = try? String(contentsOf: manifestURL, encoding: .utf8)
    else {
      throw LiveVtoGarmentValidationError("fixture manifest not found: \(name)/manifest.json")
    }
    let manifest = try KsgarmentManifest.parseAssetManifest(manifestText)

    guard
      let textureURL = bundle.url(forResource: (manifest.texture as NSString).deletingPathExtension, withExtension: (manifest.texture as NSString).pathExtension, subdirectory: name),
      let alphaURL = bundle.url(forResource: (manifest.alphaMask as NSString).deletingPathExtension, withExtension: (manifest.alphaMask as NSString).pathExtension, subdirectory: name),
      let textureImage = UIImage(contentsOfFile: textureURL.path)?.cgImage,
      let alphaImage = UIImage(contentsOfFile: alphaURL.path)?.cgImage
    else {
      throw LiveVtoGarmentValidationError("fixture texture/alpha not found under \(name)/")
    }

    let combined: CGImage
    if let cached = combinedImageCache[name] {
      combined = cached
    } else {
      guard let made = Self.combineTextureAndAlpha(texture: textureImage, alphaMask: alphaImage) else {
        throw LiveVtoGarmentValidationError("failed to combine texture+alpha for \(name)")
      }
      combinedImageCache[name] = made
      combined = made
    }
    return (manifest, combined, (textureImage.width, textureImage.height))
  }

  private func startReplay() {
    if replayDriver != nil { return }
    do {
      let (manifest, image, dims) = try loadFixture("n1b-fixture")
      replayImage = image
      let session = LiveVtoReplaySession(canvasWidth: Float(renderCanvasW), canvasHeight: Float(renderCanvasH)) { [weak self] _ in
        // Bounded state event only. Never a frame, never a BodyFrame, never
        // geometry.
        DispatchQueue.main.async { self?.setNeedsDisplay() }
      }
      let source = InterpolatedPoseReplaySource(
        id: "n1d-neutral-armraise-neutral",
        keyframes: [BodyFrame.neutral(), BodyFrame.armsSlightlyOut(), BodyFrame.neutral()],
        framesPerSegment: 60)
      guard session.load(source, manifest: manifest, textureWidth: dims.0, textureHeight: dims.1) else {
        loadError = "replay load refused"
        return
      }
      session.start()
      replaySession = session
      let driver = LiveVtoReplayDriver(session: session)
      replayDriver = driver
      driver.start()
    } catch {
      loadError = "\(error)"
    }
  }

  private func stopReplay() {
    replayDriver?.stop()
    replayDriver = nil
    replaySession?.dispose()
    replaySession = nil
    replayImage = nil
  }

  // MARK: - Perception

  private var perceptionSession: LiveVtoPerceptionSession?
  private var perceptionDriver: LiveVtoPerceptionDriver?
  private var perceptionImage: CGImage?
  /// N1-G: the "clean person frame" source for capturePersonFrame() in this
  /// mode -- there is no real camera in `perception` mode, so this is the
  /// SAME bundled synthetic image perception itself runs inference against,
  /// never the garment image (`perceptionImage`).
  private var perceptionSourceImage: UIImage?

  /// Starts/stops the real perception pipeline: bundled synthetic replay
  /// frame -> real MediaPipe inference -> BodyFrame adapter -> existing
  /// geometry pipeline -> renderer. Mirrors `replay`'s prop pattern exactly.
  public var perception: Bool = false {
    didSet {
      if perception { startPerception() } else { stopPerception() }
      setNeedsDisplay()
    }
  }

  private func startPerception() {
    if perceptionDriver != nil { return }
    do {
      let (manifest, image, dims) = try loadFixture("n1b-fixture")
      perceptionImage = image
      guard
        let testFrameURL = LiveVtoAssetBundle.shared.url(forResource: "synthetic-test-frame", withExtension: "png", subdirectory: "perception"),
        let testFrame = UIImage(contentsOfFile: testFrameURL.path)
      else {
        loadError = "perception synthetic test frame not found"
        return
      }
      perceptionSourceImage = testFrame
      let provider = LiveVtoMediaPipePoseProvider()
      let frameSource = LiveVtoStaticImageFrameSource(image: testFrame)
      let session = LiveVtoPerceptionSession(
        provider: provider, canvasWidth: Float(renderCanvasW), canvasHeight: Float(renderCanvasH),
        onEvent: { [weak self] _ in DispatchQueue.main.async { self?.setNeedsDisplay() } },
        onSnapshotComputed: { _ in
          // DIAGNOSTIC ONLY, matching Android's gate-pass/fail tally --
          // intentionally not wired to os_log at every frame to avoid
          // becoming a de facto frame-rate log channel; aggregate counters
          // are read via getPerceptionStatsJson instead.
        })
      guard session.load(manifest, textureWidth: dims.0, textureHeight: dims.1) else {
        loadError = "perception load refused: \(session.currentState())"
        return
      }
      session.start()
      perceptionSession = session
      let driver = LiveVtoPerceptionDriver(session: session, frameSource: { frameSource() })
      perceptionDriver = driver
      driver.start()
    } catch {
      loadError = "\(error)"
    }
  }

  private func stopPerception() {
    perceptionDriver?.stop()
    perceptionDriver = nil
    perceptionSession?.dispose()
    perceptionSession = nil
    perceptionImage = nil
    perceptionSourceImage = nil
  }

  /// Bounded perception telemetry for gate evidence. Aggregate counters only.
  public func readPerceptionStatsJson() -> String? {
    guard let session = perceptionSession else { return nil }
    let s = session.stats()
    return "{\"state\":\"\(session.currentState().rawValue)\""
      + ",\"produced\":\(s.produced)"
      + ",\"submittedToPerception\":\(s.submittedToPerception)"
      + ",\"inferred\":\(s.inferred)"
      + ",\"droppedBeforePerception\":\(s.droppedBeforePerception)"
      + ",\"refused\":\(s.refused)"
      + ",\"rendered\":\(s.rendered)"
      + ",\"droppedBeforeRender\":\(s.droppedBeforeRender)"
      + ",\"maxInputSlotDepth\":\(s.maxInputSlotDepth)"
      + ",\"maxGeometrySlotDepth\":\(s.maxGeometrySlotDepth)}"
  }

  /// Bounded replay telemetry for gate evidence. Aggregate counters only.
  public func readReplayStatsJson() -> String? {
    guard let session = replaySession else { return nil }
    let s = session.stats()
    return "{\"state\":\"\(session.currentState().rawValue)\""
      + ",\"fixtureId\":\"\(session.currentFixtureId() ?? "")\""
      + ",\"produced\":\(s.produced)"
      + ",\"rendered\":\(s.rendered)"
      + ",\"dropped\":\(s.dropped)"
      + ",\"maxSlotDepth\":\(s.maxSlotDepth)"
      + ",\"refused\":\(s.refused)}"
  }

  // MARK: - N1-F camera-live

  private var cameraController: LiveVtoCameraController?
  private var cameraPerceptionSession: LiveVtoPerceptionSession?
  private var cameraPerceptionDriver: LiveVtoPerceptionDriver?
  private var cameraImage: CGImage?
  private var cameraPreviewContainer: LiveVtoCameraPreviewContainerView?
  private var cameraMeshOverlay: LiveVtoMeshOverlayView?
  private var cameraControllerState: CameraControllerState = .idle
  private var cameraControllerError: String?

  /// Starts/stops the SAME real perception pipeline `perception` already
  /// proved (MediaPipe -> BodyFrameAdapter -> rigid gate -> deformation ->
  /// renderer), sourced from a LIVE front camera instead of the bundled
  /// synthetic frame (mission section 7). Deliberately a SEPARATE session/
  /// driver pair from `perception`'s, mirroring this file's own established
  /// pattern of one independent prop+session+driver per phase.
  public var camera: Bool = false {
    didSet {
      if camera { startCamera() } else { stopCamera() }
      setNeedsDisplay()
    }
  }

  private func startCamera() {
    if cameraController != nil { return }
    do {
      let (manifest, image, dims) = try loadFixture("n1b-fixture")
      cameraImage = image

      let previewContainer = LiveVtoCameraPreviewContainerView(frame: bounds)
      previewContainer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      insertSubview(previewContainer, at: 0)
      cameraPreviewContainer = previewContainer

      let overlay = LiveVtoMeshOverlayView(frame: bounds)
      overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      overlay.backgroundColor = .clear
      overlay.isOpaque = false
      overlay.onDraw = { [weak self] context, rect in self?.drawCameraOverlay(context, rect: rect) }
      addSubview(overlay) // added after the preview container -> stacks above it
      cameraMeshOverlay = overlay

      let controller = LiveVtoCameraController(previewLayer: previewContainer.previewLayer) { [weak self] state, reason in
        DispatchQueue.main.async {
          self?.cameraControllerState = state
          self?.cameraControllerError = reason
          self?.cameraMeshOverlay?.setNeedsDisplay()
        }
      }
      cameraController = controller

      let provider = LiveVtoMediaPipePoseProvider()
      let session = LiveVtoPerceptionSession(
        provider: provider, canvasWidth: Float(renderCanvasW), canvasHeight: Float(renderCanvasH),
        onEvent: { [weak self] _ in DispatchQueue.main.async { self?.cameraMeshOverlay?.setNeedsDisplay() } })
      guard session.load(manifest, textureWidth: dims.0, textureHeight: dims.1) else {
        loadError = "camera perception load refused: \(session.currentState())"
        return
      }
      session.start()
      cameraPerceptionSession = session
      let driver = LiveVtoPerceptionDriver(session: session, frameSource: { [weak controller] in controller?.latestFrame() })
      cameraPerceptionDriver = driver
      driver.start()
      // The camera producer (AVCaptureVideoDataOutput's own delegate
      // callback) starts only once the perception session is READY to
      // receive frames -- starting it first would let camera-produced
      // frames pile up against a slot nothing is draining yet, which
      // `LatestStateSlot` would count as drops that never represented real
      // backpressure.
      controller.start()
    } catch {
      loadError = "\(error)"
    }
  }

  private func stopCamera() {
    cameraPerceptionDriver?.stop()
    cameraPerceptionDriver = nil
    cameraPerceptionSession?.dispose()
    cameraPerceptionSession = nil
    cameraController?.stop()
    cameraController = nil
    cameraPreviewContainer?.removeFromSuperview()
    cameraPreviewContainer = nil
    cameraMeshOverlay?.removeFromSuperview()
    cameraMeshOverlay = nil
    cameraImage = nil
  }

  /// Bounded end-to-end telemetry for gate evidence: the camera boundary's
  /// own produced/dropped counters alongside the SAME perception counters
  /// `perception` already exposes for the downstream stages. Never a frame,
  /// a landmark, or a BodyFrame.
  public func readCameraStatsJson() -> String? {
    guard let controller = cameraController else { return nil }
    let session = cameraPerceptionSession
    let s = session?.stats()
    let errorJson = cameraControllerError.map { "\"" + $0.replacingOccurrences(of: "\"", with: "'") + "\"" } ?? "null"
    return "{\"controllerState\":\"\(cameraControllerState.rawValue)\""
      + ",\"controllerError\":\(errorJson)"
      + ",\"cameraProduced\":\(controller.frameSlot.publishedCount)"
      + ",\"cameraConsumedByPerceptionTick\":\(controller.frameSlot.consumedCount)"
      + ",\"cameraDroppedBeforePerceptionTick\":\(controller.frameSlot.droppedCount)"
      + ",\"perceptionState\":\"\(session?.currentState().rawValue ?? "NONE")\""
      + ",\"submittedToPerception\":\(s?.submittedToPerception ?? 0)"
      + ",\"inferred\":\(s?.inferred ?? 0)"
      + ",\"droppedBeforePerception\":\(s?.droppedBeforePerception ?? 0)"
      + ",\"refused\":\(s?.refused ?? 0)"
      + ",\"rendered\":\(s?.rendered ?? 0)"
      + ",\"droppedBeforeRender\":\(s?.droppedBeforeRender ?? 0)}"
  }

  private func drawCameraOverlay(_ context: CGContext, rect: CGRect) {
    guard let session = cameraPerceptionSession, let image = cameraImage else { return }
    let fitScale = min(rect.width / renderCanvasW, rect.height / renderCanvasH)
    let snapshot = session.consumeForRender() ?? session.geometrySlot.peek()
    context.saveGState()
    context.scaleBy(x: fitScale, y: fitScale)
    if let verts = snapshot?.meshVertices, let snapshot = snapshot {
      drawMesh(context, image: image, meshCellsWide: snapshot.meshWidth, meshCellsHigh: snapshot.meshHeight, verts: verts, textureWidth: snapshot.textureWidth, textureHeight: snapshot.textureHeight)
    }
    context.restoreGState()
    let st = session.stats()
    drawText(
      context, "camera=\(cameraControllerState.rawValue) produced=\(st.produced) inferred=\(st.inferred) rendered=\(st.rendered) refused=\(st.refused)",
      at: CGPoint(x: 20, y: 24), color: UIColor.cyan)
    if snapshot?.meshVertices == nil {
      drawText(
        context, "no mesh: \(snapshot?.failure ?? snapshot?.gateFindings.description ?? "unknown")",
        at: CGPoint(x: 20, y: 48), color: UIColor.red)
    }
    if session.currentState() == .playing { cameraMeshOverlay?.setNeedsDisplay() }
  }

  // MARK: - Lifecycle

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      // N1-G: module-level capturePersonFrame()/capturePreview() (unlike
      // the diagnostic Props/AsyncFunctions above, which are View-scoped)
      // need to reach whichever LiveVtoRenderView is CURRENTLY mounted --
      // exactly one exists at a time by construction (mission section 14
      // extended to capture).
      Self.currentInstance = self
    }
    // Lifecycle safety: a view torn down mid-replay must not leave a
    // background thread producing geometry into an orphaned session.
    if window == nil {
      stopReplay()
      stopPerception()
      stopCamera()
      if Self.currentInstance === self { Self.currentInstance = nil }
      clearCaptureFiles()
    }
  }

  deinit {
    replayDriver?.stop()
    replaySession?.dispose()
    perceptionDriver?.stop()
    perceptionSession?.dispose()
    cameraPerceptionDriver?.stop()
    cameraPerceptionSession?.dispose()
    cameraController?.stop()
    if LiveVtoRenderView.currentInstance === self { LiveVtoRenderView.currentInstance = nil }
  }

  // MARK: - N1-G capture (capturePersonFrame / capturePreview)

  /// Exactly one `LiveVtoRenderView` is mounted at a time by construction.
  /// `weak` so a leaked/forgotten reference here can never keep a
  /// destroyed view alive, and so a stale reference from a previous
  /// session correctly resolves to nil rather than resurrecting it.
  private static weak var currentInstance: LiveVtoRenderView?

  static func capturePersonFrame() throws -> [String: Any] {
    guard let view = currentInstance else {
      throw LiveVtoCaptureError.noActiveSession
    }
    guard let result = view.captureCleanFrame() else {
      throw LiveVtoCaptureError.captureUnavailable
    }
    return result.asDictionary
  }

  static func capturePreview() throws -> [String: Any] {
    guard let view = currentInstance else {
      throw LiveVtoCaptureError.noActiveSession
    }
    guard let result = view.captureCompositedFrame() else {
      throw LiveVtoCaptureError.captureUnavailable
    }
    return result.asDictionary
  }

  /// The clean-frame source for `capturePersonFrame()` -- NEVER the
  /// garment image (`cameraImage`/`perceptionImage`), NEVER the composited
  /// mesh (see `captureCompositedFrame()`). Priority mirrors whichever
  /// pipeline is actually running:
  ///   - `camera`: the latest published camera frame,
  ///     `cameraController.frameSlot.peek()` -- non-destructive (`peek`,
  ///     not `consume`) so this never steals a frame the perception tick
  ///     was about to drain. Real physical-camera evidence remains
  ///     PENDING-RUNTIME on iOS (no iPhone this session, same as Android's
  ///     documented HOLD) -- this method is wired to the SAME
  ///     `cameraController` the live pipeline uses; if it has never
  ///     published a frame, `peek()` returns nil and this method honestly
  ///     returns nil rather than fabricating a result.
  ///   - `perception`: the bundled synthetic test image perception itself
  ///     runs inference against -- there is no camera concept in this mode.
  ///   - `replay`/`active`/no mode: no person-frame concept exists in
  ///     those modes at all (purely canned-pose rendering); returns nil.
  private func captureCleanFrame() -> LiveVtoCapturedFrameResult? {
    let source: UIImage?
    if camera {
      guard let frame = cameraController?.frameSlot.peek() as? LiveVtoStaticImageFrame else { return nil }
      source = frame.image
    } else if perception {
      source = perceptionSourceImage
    } else {
      source = nil
    }
    guard let image = source else { return nil }
    return saveCapturedImage(image, kind: "PERSON_FRAME")
  }

  /// The composited-preview source for `capturePreview()`: rasterizes
  /// whatever is CURRENTLY on screen the same way any UIView is
  /// snapshotted, working uniformly across every mode without needing
  /// mode-specific compositing logic of its own. This is why
  /// `capturePreview` can never accidentally return a clean frame: it does
  /// not read any of the same source fields `captureCleanFrame` does.
  private func captureCompositedFrame() -> LiveVtoCapturedFrameResult? {
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    let renderer = UIGraphicsImageRenderer(bounds: bounds)
    let image = renderer.image { context in
      layer.render(in: context.cgContext)
    }
    return saveCapturedImage(image, kind: "PREVIEW")
  }

  /// Data retention (mission section 19): captures are written to this
  /// app's own caches directory (`Caches/live-vto-captures/<uuid>.png`),
  /// never a shared/photo-library location, never included in logs.
  /// Lifetime is bounded to the life of this view instance:
  /// `didMoveToWindow`'s detach path deletes the entire directory, so a
  /// capture the caller has not yet consumed (uploaded, displayed, or
  /// otherwise persisted elsewhere) before the Live session ends is
  /// deleted along with the session, not kept indefinitely as a stray
  /// temp file.
  private func saveCapturedImage(_ image: UIImage, kind: String) -> LiveVtoCapturedFrameResult? {
    guard let data = image.pngData() else { return nil }
    let captureId = UUID().uuidString
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(Self.captureCacheSubdir, isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let file = dir.appendingPathComponent("\(captureId).png")
      try data.write(to: file, options: .atomic)
      return LiveVtoCapturedFrameResult(
        captureId: captureId, kind: kind, localUri: file.absoluteString,
        width: Int(image.size.width * image.scale), height: Int(image.size.height * image.scale))
    } catch {
      return nil
    }
  }

  private func clearCaptureFiles() {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(Self.captureCacheSubdir, isDirectory: true)
    try? FileManager.default.removeItem(at: dir)
  }

  private static let captureCacheSubdir = "live-vto-captures"

  // MARK: - N1-B static compute

  private func loadAndCompute() {
    do {
      let (manifest, image, dims) = try loadFixture("n1b-fixture")
      garmentImage = image
      // Exactly the same pure pipeline the SwiftPM conformance tests run --
      // the view computes nothing of its own.
      let snapshot = LiveVtoGeometryPipeline.compute(
        manifest: manifest, frame: BodyFrame.neutral(), bodyFrameId: "neutral-frontal",
        canvasWidth: Float(renderCanvasW), canvasHeight: Float(renderCanvasH),
        textureWidth: dims.0, textureHeight: dims.1)
      meshWidth = snapshot.meshWidth
      meshHeight = snapshot.meshHeight
      meshVerts = snapshot.meshVertices
      lastSnapshot = snapshot
    } catch {
      loadError = "\(error)"
      lastSnapshot = nil
    }
  }

  /// Diagnostic snapshot read, rate-limited.
  ///
  /// A caller that polls this cannot turn it into a per-frame geometry
  /// channel: reads inside the window return the SAME cached string rather
  /// than a fresh computation, and the bridge sees at most one distinct
  /// snapshot per window regardless of call rate. Returns `nil` before the
  /// first compute.
  public func readDiagnosticSnapshotJson() -> String? {
    guard let snapshot = lastSnapshot else { return nil }
    let now = Date()
    if let cached = cachedSnapshotJson, let at = cachedSnapshotAt, now.timeIntervalSince(at) < diagnosticSnapshotMinInterval {
      return cached
    }
    let encoded = GeometrySnapshotJson.encode(snapshot, includeMesh: false)
    cachedSnapshotJson = encoded
    cachedSnapshotAt = now
    return encoded
  }

  /// Combines texture's RGB with the alpha mask's coverage. Coverage is
  /// max(alpha mask's own alpha channel, alpha mask's luminance), matching
  /// Android's `combineTextureAndAlpha` exactly -- same documented
  /// simplification, same rationale: works whichever convention the asset
  /// pipeline used without needing to hand-verify individual PNG bytes.
  private static func combineTextureAndAlpha(texture: CGImage, alphaMask: CGImage) -> CGImage? {
    let w = texture.width, h = texture.height
    guard w > 0, h > 0 else { return nil }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bytesPerRow = w * 4

    func readPixels(_ image: CGImage) -> [UInt8]? {
      var buffer = [UInt8](repeating: 0, count: bytesPerRow * h)
      guard let ctx = CGContext(
        data: &buffer, width: w, height: h, bitsPerComponent: 8, bytesPerRow: bytesPerRow,
        space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else { return nil }
      // A CGContext built directly from a data buffer (unlike a UIView's own
      // draw(_:) context, which UIKit pre-flips) uses Core Graphics' NATIVE
      // bottom-left-origin, Y-up convention, while `buffer` itself must be
      // read back row-major TOP-to-bottom to match the CGImage constructor
      // used below. Without this flip, `image`'s top row would land in the
      // buffer's highest memory rows instead of its lowest -- a vertically
      // mirrored read that would silently combine the wrong texture row
      // with the wrong alpha row.
      ctx.translateBy(x: 0, y: CGFloat(h))
      ctx.scaleBy(x: 1, y: -1)
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
      return buffer
    }

    guard let texPixels = readPixels(texture), let alphaPixels = readPixels(alphaMask) else { return nil }

    var outPixels = [UInt8](repeating: 0, count: bytesPerRow * h)
    for i in 0..<(w * h) {
      let o = i * 4
      let tr = texPixels[o], tg = texPixels[o + 1], tb = texPixels[o + 2]
      let ar = Int(alphaPixels[o]), ag = Int(alphaPixels[o + 1]), ab = Int(alphaPixels[o + 2]), aa = Int(alphaPixels[o + 3])
      let luminance = (ar * 3 + ag * 6 + ab) / 10
      let coverage = max(aa, luminance)
      outPixels[o] = tr
      outPixels[o + 1] = tg
      outPixels[o + 2] = tb
      outPixels[o + 3] = UInt8(clamping: coverage)
    }

    // Built directly from the unpremultiplied buffer (RGB taken as-is from
    // the texture, alpha replaced by the computed coverage) rather than via
    // another CGContext -- CGBitmapContext requires premultiplied (or no)
    // alpha for drawing INTO, which would force re-multiplying `outPixels`
    // by `coverage` a second time and risk a double-multiplication bug.
    // CGImage itself has no such restriction as a plain data source.
    guard let provider = CGDataProvider(data: Data(outPixels) as CFData) else { return nil }
    return CGImage(
      width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
      space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
      provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
  }

  // MARK: - Drawing

  /// Draws a deformed mesh via per-triangle affine warps -- Core Graphics has
  /// no direct equivalent of Android's `Canvas.drawBitmapMesh`, so each mesh
  /// cell (a quad) is split into two triangles, and each triangle is drawn by
  /// clipping to its destination shape, concatenating the unique
  /// `CGAffineTransform` that maps that triangle's THREE texture-space source
  /// points onto its three destination-canvas points, then drawing the full
  /// source image (which lands correctly only inside the clipped region).
  /// This is a standard, textbook technique for warping an image over an
  /// arbitrary triangle mesh using only Core Graphics primitives.
  private func drawMesh(_ context: CGContext, image: CGImage, meshCellsWide: Int, meshCellsHigh: Int, verts: [Float], textureWidth: Int, textureHeight: Int) {
    guard meshCellsWide > 0, meshCellsHigh > 0, textureWidth > 0, textureHeight > 0 else { return }
    let vertsPerRow = meshCellsWide + 1
    func destAt(_ col: Int, _ row: Int) -> CGPoint {
      let i = (row * vertsPerRow + col) * 2
      return CGPoint(x: CGFloat(verts[i]), y: CGFloat(verts[i + 1]))
    }
    func sourceAt(_ col: Int, _ row: Int) -> CGPoint {
      CGPoint(x: CGFloat(col) / CGFloat(meshCellsWide) * CGFloat(textureWidth),
              y: CGFloat(row) / CGFloat(meshCellsHigh) * CGFloat(textureHeight))
    }
    for row in 0..<meshCellsHigh {
      for col in 0..<meshCellsWide {
        let d00 = destAt(col, row), d10 = destAt(col + 1, row), d01 = destAt(col, row + 1), d11 = destAt(col + 1, row + 1)
        let s00 = sourceAt(col, row), s10 = sourceAt(col + 1, row), s01 = sourceAt(col, row + 1), s11 = sourceAt(col + 1, row + 1)
        drawTriangle(context, image: image, src: (s00, s10, s01), dst: (d00, d10, d01))
        drawTriangle(context, image: image, src: (s10, s11, s01), dst: (d10, d11, d01))
      }
    }
  }

  private func drawTriangle(_ context: CGContext, image: CGImage, src: (CGPoint, CGPoint, CGPoint), dst: (CGPoint, CGPoint, CGPoint)) {
    // Solve the affine transform T with T(src.0)=dst.0, T(src.1)=dst.1, T(src.2)=dst.2.
    // Edge vectors: M_src * A = M_dst  =>  A = M_dst * M_src^-1 (2x2), then translation from src.0/dst.0.
    let sx1 = Double(src.1.x - src.0.x), sy1 = Double(src.1.y - src.0.y)
    let sx2 = Double(src.2.x - src.0.x), sy2 = Double(src.2.y - src.0.y)
    let dx1 = Double(dst.1.x - dst.0.x), dy1 = Double(dst.1.y - dst.0.y)
    let dx2 = Double(dst.2.x - dst.0.x), dy2 = Double(dst.2.y - dst.0.y)

    let det = sx1 * sy2 - sy1 * sx2
    guard abs(det) > 1e-9 else { return } // degenerate triangle -- nothing to draw

    let invDet = 1.0 / det
    // M_src^-1
    let ia = sy2 * invDet, ib = -sy1 * invDet
    let ic = -sx2 * invDet, id = sx1 * invDet

    // A = [dx1 dx2; dy1 dy2] * [ia ib; ic id]
    let a = dx1 * ia + dx2 * ic
    let b = dy1 * ia + dy2 * ic
    let c = dx1 * ib + dx2 * id
    let d = dy1 * ib + dy2 * id
    // translation: dst.0 = A*src.0 + t  =>  t = dst.0 - A*src.0
    let tx = Double(dst.0.x) - (a * Double(src.0.x) + c * Double(src.0.y))
    let ty = Double(dst.0.y) - (b * Double(src.0.x) + d * Double(src.0.y))

    let transform = CGAffineTransform(a: CGFloat(a), b: CGFloat(b), c: CGFloat(c), d: CGFloat(d), tx: CGFloat(tx), ty: CGFloat(ty))

    context.saveGState()
    let path = CGMutablePath()
    path.move(to: dst.0)
    path.addLine(to: dst.1)
    path.addLine(to: dst.2)
    path.closeSubpath()
    context.addPath(path)
    context.clip()
    context.concatenate(transform)
    // Now in texture-space coordinates (post-concat): clip additionally to
    // the alpha mask's own coverage (already baked into `image` by
    // `combineTextureAndAlpha`, so this draw call alone carries both the
    // garment silhouette and its texture).
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    context.restoreGState()
  }

  private func drawReplayOrPerception(_ context: CGContext, rect: CGRect, isPerception: Bool) {
    let fitScale = min(rect.width / renderCanvasW, rect.height / renderCanvasH)
    let session: (state: ReplayState, consume: () -> GeometrySnapshot?, peek: () -> GeometrySnapshot?)
    let image: CGImage?
    let label: String

    if isPerception {
      guard let s = perceptionSession, let img = perceptionImage else {
        drawText(context, "perception not started", at: CGPoint(x: 20, y: 24), color: UIColor.yellow)
        return
      }
      session = (s.currentState(), { s.consumeForRender() }, { s.geometrySlot.peek() })
      image = img
      let st = s.stats()
      label = "\(s.currentState().rawValue) produced=\(st.produced) inferred=\(st.inferred) refused=\(st.refused) rendered=\(st.rendered) droppedP=\(st.droppedBeforePerception) droppedR=\(st.droppedBeforeRender)"
    } else {
      guard let s = replaySession, let img = replayImage else {
        drawText(context, "replay not started", at: CGPoint(x: 20, y: 24), color: UIColor.yellow)
        return
      }
      session = (s.currentState(), { s.consumeForRender() }, { s.slot.peek() })
      image = img
      let st = s.stats()
      label = "\(s.currentState().rawValue) produced=\(st.produced) rendered=\(st.rendered) dropped=\(st.dropped)"
    }

    let snapshot = session.consume() ?? session.peek()
    context.saveGState()
    // NOT flipped here: a UIView's draw(_:) context is already pre-flipped
    // by UIKit to top-left-origin, Y-down (unlike a raw off-screen
    // CGContext, e.g. the one `combineTextureAndAlpha` builds) -- exactly
    // the orientation the geometry pipeline's coordinates already use, and
    // exactly what makes `context.draw(image, in:)` show the image
    // right-side-up without help. Adding a manual flip here would
    // double-flip both the image and the mesh coordinates.
    context.scaleBy(x: fitScale, y: fitScale)
    if let verts = snapshot?.meshVertices, let image = image, let snapshot = snapshot {
      drawMesh(context, image: image, meshCellsWide: snapshot.meshWidth, meshCellsHigh: snapshot.meshHeight, verts: verts, textureWidth: snapshot.textureWidth, textureHeight: snapshot.textureHeight)
    }
    context.restoreGState()
    drawText(context, label, at: CGPoint(x: 20, y: 24), color: isPerception ? UIColor.cyan : UIColor.green)

    if session.state == .playing { setNeedsDisplay() } // redraw on the UI's own cadence, deliberately decoupled from production
  }

  private func drawText(_ context: CGContext, _ text: String, at point: CGPoint, color: UIColor) {
    let attrs: [NSAttributedString.Key: Any] = [.foregroundColor: color, .font: UIFont.systemFont(ofSize: 14)]
    (text as NSString).draw(at: point, withAttributes: attrs)
  }

  public override func draw(_ rect: CGRect) {
    super.draw(rect)
    if camera {
      // The live camera feed and the mesh overlay are both separate child
      // views (see `startCamera()`), stacked above this view's own layer --
      // this view's own `draw(_:)` has nothing to paint for this mode.
      return
    }
    guard let context = UIGraphicsGetCurrentContext() else { return }
    context.setFillColor(UIColor(red: 32 / 255, green: 32 / 255, blue: 36 / 255, alpha: 1).cgColor)
    context.fill(rect)

    if perception {
      drawReplayOrPerception(context, rect: rect, isPerception: true)
      return
    }
    if replay {
      drawReplayOrPerception(context, rect: rect, isPerception: false)
      return
    }
    guard active else { return }
    if let err = loadError {
      drawText(context, "N1-A(iOS) render error: \(err)", at: CGPoint(x: 20, y: 40), color: .red)
      return
    }
    guard let image = garmentImage else { return }

    let fitScale = min(rect.width / renderCanvasW, rect.height / renderCanvasH)
    context.saveGState()
    // See the comment in `drawReplayOrPerception` -- no manual flip needed
    // inside a UIView's own draw(_:) context.
    context.scaleBy(x: fitScale, y: fitScale)

    // Faint landmark markers for the canned pose -- visual alignment aid, not perception.
    context.setFillColor(UIColor(red: 1, green: 1, blue: 0, alpha: 160 / 255).cgColor)
    let frame = BodyFrame.neutral()
    for landmark in [frame.leftShoulder, frame.rightShoulder, frame.leftHip, frame.rightHip, frame.leftElbow, frame.rightElbow] {
      guard let p = landmark.pointOrNull else { continue }
      let px = toCanvasPx(p, canvasWidth: Float(renderCanvasW), canvasHeight: Float(renderCanvasH))
      context.fillEllipse(in: CGRect(x: CGFloat(px.x) - 6, y: CGFloat(px.y) - 6, width: 12, height: 12))
    }

    if let verts = meshVerts {
      drawMesh(context, image: image, meshCellsWide: meshWidth, meshCellsHigh: meshHeight, verts: verts, textureWidth: lastSnapshot?.textureWidth ?? image.width, textureHeight: lastSnapshot?.textureHeight ?? image.height)
    }
    context.restoreGState()
    if meshVerts == nil {
      drawText(context, "no mesh: \(lastSnapshot?.failure ?? lastSnapshot?.gateFindings.description ?? "unknown")", at: CGPoint(x: 20, y: 40), color: .red)
    }
  }
}

/// A handle to a frame this module captured, matching `LiveVtoCapturedFrame`
/// in types/vtoLive.ts exactly.
struct LiveVtoCapturedFrameResult {
  let captureId: String
  /// "PERSON_FRAME" or "PREVIEW" -- see `LIVE_VTO_CAPTURED_FRAME_KINDS` in types/vtoLive.ts.
  let kind: String
  let localUri: String
  let width: Int
  let height: Int

  var asDictionary: [String: Any] {
    ["captureId": captureId, "kind": kind, "localUri": localUri, "width": width, "height": height]
  }
}

enum LiveVtoCaptureError: Error {
  case noActiveSession
  case captureUnavailable
}
