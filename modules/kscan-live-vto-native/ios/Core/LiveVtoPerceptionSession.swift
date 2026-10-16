import Foundation

/// Drives NATIVE FRAME -> REAL PERCEPTION -> BodyFrame -> existing geometry
/// pipeline -> existing renderer. Field-for-field port of Android's
/// `LiveVtoPerceptionSession.kt`.
///
/// Reuses `LatestStateSlot` for BOTH boundaries this session has to be
/// bounded across:
///
///   frame producer -> [inputSlot: PerceptionInputFrame] -> perception step
///   perception step -> [geometrySlot: GeometrySnapshot]  -> render consume
///
/// Two independent slots, two independent drop counters -- deliberately never
/// merged: "replay drops" (a produced frame that was never even submitted to
/// perception because a newer one overwrote it) and "inference drops" (a
/// computed geometry snapshot the renderer never consumed) are different
/// failure modes with different remedies.
///
/// This session owns no threads of its own, exactly like
/// `LiveVtoReplaySession` -- `submitFrame` is called by whatever produces
/// frames, `runOneInferenceStep` by whatever runs the perception loop
/// (`LiveVtoPerceptionDriver`), so the whole state machine and its
/// bounded-drop accounting is testable on the host against a fake
/// `PerceptionProvider`, independent of whether a real device can execute the
/// real model.
public struct PerceptionStats {
  public let produced: Int64
  public let submittedToPerception: Int64
  public let inferred: Int64
  public let droppedBeforePerception: Int64
  public let refused: Int64
  public let rendered: Int64
  public let droppedBeforeRender: Int64
  public let maxInputSlotDepth: Int
  public let maxGeometrySlotDepth: Int
}

public final class LiveVtoPerceptionSession {
  private let provider: PerceptionProvider
  private let canvasWidth: Float
  private let canvasHeight: Float
  private let onEvent: (ReplayEvent) -> Void
  /// Diagnostic-only observer, fired synchronously on the perception thread
  /// right after a geometry snapshot is computed (whether or not its rigid
  /// gate passed). Never used to leak data across the JS bridge --
  /// native-side logging only.
  private let onSnapshotComputed: (GeometrySnapshot) -> Void

  private let lock = NSLock()
  private var state: ReplayState = .idle
  private var garment: KsgarmentManifest?
  private var textureWidth: Int = 0
  private var textureHeight: Int = 0
  private var lastError: String?

  public let inputSlot = LatestStateSlot<PerceptionInputFrame>()
  public let geometrySlot = LatestStateSlot<GeometrySnapshot>()

  private var producedCount: Int64 = 0
  private var inferredCount: Int64 = 0
  private var refusedCount: Int64 = 0
  private var maxInputDepth = 0
  private var maxGeometryDepth = 0

  public init(
    provider: PerceptionProvider, canvasWidth: Float, canvasHeight: Float,
    onEvent: @escaping (ReplayEvent) -> Void = { _ in },
    onSnapshotComputed: @escaping (GeometrySnapshot) -> Void = { _ in }
  ) {
    self.provider = provider
    self.canvasWidth = canvasWidth
    self.canvasHeight = canvasHeight
    self.onEvent = onEvent
    self.onSnapshotComputed = onSnapshotComputed
  }

  public func currentState() -> ReplayState { lock.lock(); defer { lock.unlock() }; return state }

  public func stats() -> PerceptionStats {
    lock.lock()
    let produced = producedCount, inferred = inferredCount, refused = refusedCount
    let maxIn = maxInputDepth, maxGeo = maxGeometryDepth
    lock.unlock()
    return PerceptionStats(
      produced: produced, submittedToPerception: inputSlot.publishedCount, inferred: inferred,
      droppedBeforePerception: inputSlot.droppedCount, refused: refused,
      rendered: geometrySlot.consumedCount, droppedBeforeRender: geometrySlot.droppedCount,
      maxInputSlotDepth: maxIn, maxGeometrySlotDepth: maxGeo)
  }

  /// Caller must already hold `lock`.
  private func emit() {
    onEvent(ReplayEvent(state: state, fixtureId: garment?.productId, sourceId: provider.getCapability().providerName, error: lastError))
  }

  /// Caller must already hold `lock`.
  private func transition(_ next: ReplayState) {
    if next == .error {
      inputSlot.clear()
      geometrySlot.clear()
    }
    state = next
    emit()
  }

  /// Loads a garment and initializes the real perception provider. This is
  /// the ONLY place `provider.initialize()` is called -- a real model load,
  /// on whatever thread calls `load()` (the driver calls it from the
  /// perception thread, never the main thread).
  @discardableResult
  public func load(_ manifest: KsgarmentManifest, textureWidth texWidth: Int, textureHeight texHeight: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if state == .disposed { return false }
    if state == .playing || state == .paused { return false }
    transition(.loading)
    guard texWidth > 0, texHeight > 0 else {
      lastError = "invalid texture dimensions"
      transition(.error)
      return false
    }
    let ok = provider.initialize()
    guard ok else {
      lastError = lastError ?? "provider.initialize() returned false"
      transition(.error)
      return false
    }
    garment = manifest
    textureWidth = texWidth
    textureHeight = texHeight
    lastError = nil
    inputSlot.clear()
    geometrySlot.clear()
    transition(.ready)
    return true
  }

  @discardableResult
  public func start() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .ready || state == .stopped else { return false }
    transition(.playing)
    return true
  }

  @discardableResult
  public func stop() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .playing || state == .paused else { return false }
    inputSlot.clear()
    geometrySlot.clear()
    transition(.stopped)
    return true
  }

  @discardableResult
  public func dispose() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if state == .disposed { return false }
    inputSlot.clear()
    geometrySlot.clear()
    provider.dispose()
    state = .disposed
    onEvent(ReplayEvent(state: .disposed, fixtureId: nil, sourceId: provider.getCapability().providerName, error: lastError))
    return true
  }

  /// Called by the (fast) frame-producer clock. Bounded: publish overwrites, never queues.
  @discardableResult
  public func submitFrame(_ frame: PerceptionInputFrame) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .playing else { return false }
    producedCount += 1
    inputSlot.publish(frame)
    if inputSlot.depth > maxInputDepth { maxInputDepth = inputSlot.depth }
    return true
  }

  /// Called by the (slower, real-inference-bound) perception loop. Runs REAL
  /// provider inference -- never traps: a provider error is caught, counted
  /// as refused, and the session stays alive for the next frame.
  @discardableResult
  public func runOneInferenceStep() -> Bool {
    let activeGarment: KsgarmentManifest
    let texW: Int
    let texH: Int
    let input: PerceptionInputFrame
    lock.lock()
    guard state == .playing, let g = garment, let f = inputSlot.consume() else { lock.unlock(); return false }
    activeGarment = g
    texW = textureWidth
    texH = textureHeight
    input = f
    lock.unlock()

    let result = provider.processFrame(input)
    lock.lock()
    inferredCount += 1
    let inferredSoFar = inferredCount
    lock.unlock()

    switch result {
    case .success(let frame):
      switch LiveVtoBodyFrameAdapter.adapt(frame) {
      case .mapped(let adapted):
        let snapshot = LiveVtoGeometryPipeline.compute(
          manifest: activeGarment, frame: adapted, bodyFrameId: "perception#\(inferredSoFar)",
          canvasWidth: canvasWidth, canvasHeight: canvasHeight, textureWidth: texW, textureHeight: texH)
        onSnapshotComputed(snapshot)
        lock.lock()
        if state == .playing && garment?.productId == activeGarment.productId && garment == activeGarment {
          geometrySlot.publish(snapshot)
          if geometrySlot.depth > maxGeometryDepth { maxGeometryDepth = geometrySlot.depth }
        }
        lock.unlock()
      case .noUsablePose, .invalidProviderOutput:
        lock.lock(); refusedCount += 1; lock.unlock()
      }
    case .noPose, .failure:
      lock.lock(); refusedCount += 1; lock.unlock()
    }
    return true
  }

  public func consumeForRender() -> GeometrySnapshot? { geometrySlot.consume() }
}
