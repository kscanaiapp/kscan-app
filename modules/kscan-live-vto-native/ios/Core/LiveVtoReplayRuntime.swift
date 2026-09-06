import Foundation

/// The deterministic native replay runtime -- field-for-field port of
/// Android's `LiveVtoReplayRuntime.kt`.
///
/// Drives the SAME native pipeline that camera input will drive later, with a
/// synthetic frame source standing in for the camera. Nothing here decodes
/// frames in JS, sends frames to JS, or sends BodyFrames to JS at frame rate
/// -- JS issues bounded commands and receives bounded state events.
///
/// ── Why production is decoupled from render ─────────────────────────────
///
/// The producer advances on its own clock and publishes each finished
/// `GeometrySnapshot` into a single-slot `LatestStateSlot`. The renderer
/// reads whatever is currently in that slot. The producer NEVER waits for a
/// render.
///
///     REPLAY CLOCK -> frame + BodyFrame -> geometry compute -> [latest slot] -> renderer
///
/// A produce-then-await-render loop would make backpressure untestable by
/// construction: nothing could ever be dropped, and a "0 dropped frames"
/// result would prove nothing at all. Here, a renderer slower than the
/// producer provably drops stale frames and the slot stays depth-1.
///
/// ── Threading ────────────────────────────────────────────────────────────
///
/// This type owns no threads. It exposes `advance()` as the single unit of
/// production work, and a driver (`LiveVtoReplayDriver`) decides what runs
/// it: a real GCD timer on device, a deterministic loop in tests. That keeps
/// the state machine and the backpressure accounting fully testable on the
/// host while the real runtime still executes production and deformation off
/// the main thread.
public enum ReplayState: String, Equatable {
  case idle = "IDLE"
  case loading = "LOADING"
  case ready = "READY"
  case playing = "PLAYING"
  case paused = "PAUSED"
  case eof = "EOF"
  case stopped = "STOPPED"
  case error = "ERROR"
  case disposed = "DISPOSED"
}

/// A single-slot latest-value holder with drop accounting.
///
/// Bounded by construction: it holds at most one value, so no producer can
/// grow an unbounded backlog and no consumer can drain stale frames after the
/// fact. Overwriting an unconsumed value is a DROP, counted, not a silent
/// loss.
///
/// Swift has no direct equivalent of the JVM's `AtomicReference`/`AtomicLong`
/// pairing Android uses here; this uses a single `NSLock` guarding all state
/// instead, which is a strictly safe (if marginally more conservative)
/// substitute for the same bounded, depth-<=1 guarantee.
public final class LatestStateSlot<T> {
  private let lock = NSLock()
  private var slot: T?
  private var dropped: Int64 = 0
  private var published: Int64 = 0
  private var consumed: Int64 = 0

  public init() {}

  public func publish(_ value: T) {
    lock.lock(); defer { lock.unlock() }
    let previous = slot
    slot = value
    published += 1
    if previous != nil { dropped += 1 }
  }

  /// Takes the current value if there is one, leaving the slot empty.
  @discardableResult
  public func consume() -> T? {
    lock.lock(); defer { lock.unlock() }
    let value = slot
    slot = nil
    if value != nil { consumed += 1 }
    return value
  }

  /// Reads without consuming -- the draw path, which must be able to redraw the same state.
  public func peek() -> T? {
    lock.lock(); defer { lock.unlock() }
    return slot
  }

  public func clear() {
    lock.lock(); defer { lock.unlock() }
    slot = nil
  }

  public var publishedCount: Int64 { lock.lock(); defer { lock.unlock() }; return published }
  public var consumedCount: Int64 { lock.lock(); defer { lock.unlock() }; return consumed }
  public var droppedCount: Int64 { lock.lock(); defer { lock.unlock() }; return dropped }

  /// Always 0 or 1. Asserted in tests: the architecture cannot queue.
  public var depth: Int { lock.lock(); defer { lock.unlock() }; return slot == nil ? 0 : 1 }
}

/// One replay frame: an index into the source plus the pose observed at it.
public struct ReplayFrame {
  public let index: Int
  public let frame: BodyFrame
  public init(index: Int, frame: BodyFrame) {
    self.index = index
    self.frame = frame
  }
}

/// A deterministic native frame source. Synthetic: a committed pose sequence,
/// no person imagery, no licensed media.
public protocol ReplayFrameSource: AnyObject {
  var frameCount: Int { get }
  var id: String { get }
  func frameAt(_ index: Int) -> ReplayFrame
}

/// Bounded state event: no frames, no landmarks, no per-frame geometry.
public struct ReplayEvent {
  public let state: ReplayState
  public let fixtureId: String?
  public let sourceId: String?
  public let error: String?

  public init(state: ReplayState, fixtureId: String?, sourceId: String?, error: String?) {
    self.state = state
    self.fixtureId = fixtureId
    self.sourceId = sourceId
    self.error = error
  }

  /// The COMPLETE set of keys this event may ever carry across the bridge.
  /// Asserted mechanically by `LiveVtoRuntimeBoundaryTests` -- adding a field
  /// to this struct without adding it here fails the build rather than
  /// silently widening the boundary.
  public static let allowedPayloadKeys: Set<String> = ["state", "fixtureId", "sourceId", "error"]

  public func toPayload() -> [String: Any?] {
    ["state": state.rawValue, "fixtureId": fixtureId, "sourceId": sourceId, "error": error]
  }
}

/// Counters for a replay run. Bounded, aggregate -- never per-frame data.
public struct ReplayStats {
  public let produced: Int64
  public let rendered: Int64
  public let dropped: Int64
  public let maxSlotDepth: Int
  public let refused: Int64
}

/// The replay state machine and production loop.
///
/// Every transition is explicit; there is no implicit state. An operation
/// that is not legal from the current state is a no-op that returns `false`,
/// never a trap and never a silent transition.
public final class LiveVtoReplaySession {
  private let canvasWidth: Float
  private let canvasHeight: Float
  private let onEvent: (ReplayEvent) -> Void
  private let lock = NSLock()

  private var state: ReplayState = .idle
  private var source: ReplayFrameSource?
  private var garment: KsgarmentManifest?
  private var textureWidth: Int = 0
  private var textureHeight: Int = 0
  private var cursor: Int = 0
  private var lastError: String?

  private var producedCount: Int64 = 0
  private var refusedCount: Int64 = 0
  private var maxDepth: Int = 0

  public let slot = LatestStateSlot<GeometrySnapshot>()

  public init(canvasWidth: Float, canvasHeight: Float, onEvent: @escaping (ReplayEvent) -> Void = { _ in }) {
    self.canvasWidth = canvasWidth
    self.canvasHeight = canvasHeight
    self.onEvent = onEvent
  }

  public func currentState() -> ReplayState { lock.lock(); defer { lock.unlock() }; return state }
  public func currentFixtureId() -> String? { lock.lock(); defer { lock.unlock() }; return garment?.productId }

  public func stats() -> ReplayStats {
    lock.lock()
    let produced = producedCount, refused = refusedCount, depth = maxDepth
    lock.unlock()
    return ReplayStats(produced: produced, rendered: slot.consumedCount, dropped: slot.droppedCount, maxSlotDepth: depth, refused: refused)
  }

  /// Caller must already hold `lock`.
  private func emit() {
    onEvent(ReplayEvent(state: state, fixtureId: garment?.productId, sourceId: source?.id, error: lastError))
  }

  /// Caller must already hold `lock`.
  private func transition(_ next: ReplayState) {
    // ERROR must drop whatever geometry is still sitting in the slot.
    // Without this, a session that has just errored still has a readable
    // snapshot, and a renderer that peeks rather than consumes keeps drawing
    // the last good frame while the session behind it is broken -- a stale
    // render indistinguishable from a working one.
    //
    // EOF deliberately does NOT clear (documented resource contract): the
    // sequence ended normally, and the final frame is the correct thing to
    // leave on screen until the caller stops, restarts, or disposes. STOPPED
    // does not clear here either -- `stop()` clears explicitly, and routing
    // it through here as well would double-count.
    if next == .error { slot.clear() }
    state = next
    emit()
  }

  /// Loads a source and a garment. Legal from IDLE, READY, STOPPED, EOF.
  @discardableResult
  public func load(_ newSource: ReplayFrameSource, manifest: KsgarmentManifest, textureWidth texWidth: Int, textureHeight texHeight: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if state == .disposed { return false }
    if state == .playing || state == .paused { return false }
    transition(.loading)
    guard newSource.frameCount > 0 else {
      lastError = "replay source has no frames"
      transition(.error)
      return false
    }
    guard texWidth > 0, texHeight > 0 else {
      lastError = "invalid texture dimensions"
      transition(.error)
      return false
    }
    source = newSource
    garment = manifest
    textureWidth = texWidth
    textureHeight = texHeight
    cursor = 0
    lastError = nil
    slot.clear()
    transition(.ready)
    return true
  }

  /// Swaps the active garment WITHOUT restarting replay.
  ///
  /// The swap takes effect at the next frame boundary -- production is
  /// single-threaded through `advance()`, so a frame is either entirely the
  /// old garment or entirely the new one. There is no window in which one
  /// snapshot could carry A's geometry and B's texture. The stale snapshot is
  /// dropped rather than left for the renderer to pick up under the new id.
  @discardableResult
  public func selectGarment(_ manifest: KsgarmentManifest, textureWidth texWidth: Int, textureHeight texHeight: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if state == .disposed || state == .error { return false }
    if texWidth <= 0 || texHeight <= 0 {
      lastError = "invalid texture dimensions for \(manifest.productId)"
      transition(.error)
      return false
    }
    garment = manifest
    textureWidth = texWidth
    textureHeight = texHeight
    slot.clear() // never let A's geometry be drawn while B is the active asset
    emit()
    return true
  }

  @discardableResult
  public func start() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .ready || state == .stopped || state == .eof else { return false }
    guard source != nil, garment != nil else { return false }
    if state == .eof || state == .stopped { cursor = 0 }
    transition(.playing)
    return true
  }

  @discardableResult
  public func pause() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .playing else { return false }
    transition(.paused)
    return true
  }

  @discardableResult
  public func resume() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .paused else { return false }
    transition(.playing)
    return true
  }

  @discardableResult
  public func stop() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .playing || state == .paused || state == .eof else { return false }
    cursor = 0
    slot.clear()
    transition(.stopped)
    return true
  }

  /// Restart from EOF or STOPPED (or PAUSED) without reloading the source.
  @discardableResult
  public func restart() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .eof || state == .stopped || state == .paused else { return false }
    cursor = 0
    slot.clear()
    transition(.playing)
    return true
  }

  @discardableResult
  public func seek(_ index: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard let total = source?.frameCount else { return false }
    if state == .disposed || state == .error { return false }
    if index < 0 || index >= total { return false }
    cursor = index
    slot.clear()
    return true
  }

  /// Terminal. After this, production stops, the slot is emptied, and no
  /// further event fires except this one. Idempotent.
  @discardableResult
  public func dispose() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if state == .disposed { return false }
    cursor = 0
    source = nil
    garment = nil
    slot.clear()
    state = .disposed
    onEvent(ReplayEvent(state: .disposed, fixtureId: nil, sourceId: nil, error: lastError))
    return true
  }

  /// One unit of production work: take the next replay frame, compute its
  /// geometry, publish it. Returns `true` if a frame was produced.
  ///
  /// Never blocks on the renderer. Never traps: a geometry refusal is
  /// published as a refusal snapshot and counted, because a runtime that
  /// crashes on a bad frame cannot survive a bad perception provider.
  @discardableResult
  public func advance() -> Bool {
    let activeSource: ReplayFrameSource
    let activeGarment: KsgarmentManifest
    let texW: Int
    let texH: Int
    let index: Int
    lock.lock()
    guard state == .playing, let src = source, let g = garment else { lock.unlock(); return false }
    activeSource = src
    activeGarment = g
    texW = textureWidth
    texH = textureHeight
    if cursor >= activeSource.frameCount {
      transition(.eof)
      lock.unlock()
      return false
    }
    index = cursor
    cursor = index + 1
    lock.unlock()

    let replayFrame = activeSource.frameAt(index)
    let snapshot = LiveVtoGeometryPipeline.compute(
      manifest: activeGarment, frame: replayFrame.frame, bodyFrameId: "\(activeSource.id)#\(replayFrame.index)",
      canvasWidth: canvasWidth, canvasHeight: canvasHeight, textureWidth: texW, textureHeight: texH)

    lock.lock(); defer { lock.unlock() }
    if snapshot.failure != nil { refusedCount += 1 }
    // Publish only if this session still owns the frame: a dispose() or a
    // garment switch that landed while geometry was computing must not have
    // a stale snapshot appear after it. Android compares by REFERENCE
    // (`garment !== activeGarment`) since Kotlin's `KsgarmentManifest` is a
    // heap object; `KsgarmentManifest` here is a Swift value type with no
    // reference identity, so structural equality is the faithful substitute
    // -- the only edge case where the two could disagree is a `selectGarment`
    // reload with byte-identical manifest content, where discarding vs.
    // keeping the in-flight snapshot are equally correct outcomes.
    // `slot` guards its own state with an independent lock, so calling it
    // while still holding the session's `lock` here cannot deadlock.
    guard state == .playing, garment == activeGarment else { return false }
    slot.publish(snapshot)
    if slot.depth > maxDepth { maxDepth = slot.depth }
    producedCount += 1
    if state == .playing && cursor >= activeSource.frameCount {
      transition(.eof)
    }
    return true
  }

  /// What the renderer calls. Consuming is what makes the next publish a non-drop.
  public func consumeForRender() -> GeometrySnapshot? { slot.consume() }
}
