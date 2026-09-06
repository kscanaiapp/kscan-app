import XCTest
@testable import LiveVtoCore

private let canvasW: Float = 720
private let canvasH: Float = 960

/// Field-for-field port of Android's `ReplayRuntimeTest.kt`: state machine,
/// non-vacuous backpressure, product switching, replay/deformation sync, the
/// privacy payload boundary, and resource discipline.
final class LiveVtoReplayRuntimeTests: XCTestCase {

  private func source(id: String = "neutral-armraise-neutral", framesPerSegment: Int = 20) throws -> ReplayFrameSource {
    let golden = try GoldenFixtures.loadBodyFrames()
    func frame(_ name: String) throws -> BodyFrame {
      guard let c = golden.cases.first(where: { $0.id == name }) else { throw LiveVtoGarmentValidationError("missing golden case \(name)") }
      return GoldenFixtures.bodyFrame(c)
    }
    return InterpolatedPoseReplaySource(
      id: id, keyframes: [try frame("neutral-frontal"), try frame("arms-slightly-out"), try frame("neutral-frontal")],
      framesPerSegment: framesPerSegment)
  }

  private func garment(_ name: String = "n1b-fixture") throws -> (KsgarmentManifest, (Int, Int)) {
    let (manifest, w, h) = try GoldenFixtures.loadManifest(fixture: name)
    return (manifest, (w, h))
  }

  private final class EventCollector {
    private let lock = NSLock()
    private var _events: [ReplayEvent] = []
    func add(_ e: ReplayEvent) { lock.lock(); _events.append(e); lock.unlock() }
    var events: [ReplayEvent] { lock.lock(); defer { lock.unlock() }; return _events }
  }

  // MARK: - State machine

  func testLifecycleFollowsTheDeclaredStateMachine() throws {
    let events = EventCollector()
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH) { events.add($0) }
    let (manifest, dims) = try garment()

    XCTAssertEqual(s.currentState(), .idle)
    XCTAssertFalse(s.start(), "start before load must be refused, not trap")
    XCTAssertFalse(s.pause(), "pause before play must be refused")

    XCTAssertTrue(s.load(try source(), manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertEqual(s.currentState(), .ready)

    XCTAssertTrue(s.start())
    XCTAssertEqual(s.currentState(), .playing)
    XCTAssertFalse(s.start(), "start while playing must be refused")

    XCTAssertTrue(s.advance())
    XCTAssertTrue(s.pause())
    XCTAssertEqual(s.currentState(), .paused)
    XCTAssertFalse(s.advance(), "a paused session must not produce frames")

    XCTAssertTrue(s.resume())
    XCTAssertEqual(s.currentState(), .playing)

    XCTAssertTrue(s.stop())
    XCTAssertEqual(s.currentState(), .stopped)
    XCTAssertFalse(s.advance(), "a stopped session must not produce frames")

    XCTAssertTrue(s.dispose())
    XCTAssertEqual(s.currentState(), .disposed)

    // LOADING is transient but must actually be entered, not skipped.
    XCTAssertTrue(events.events.contains { $0.state == .loading }, "LOADING must be observable")
    let seenStates = Set(events.events.map(\.state))
    for expected: ReplayState in [.ready, .playing, .paused, .stopped, .disposed] {
      XCTAssertTrue(seenStates.contains(expected), "missing state \(expected)")
    }
  }

  func testEofStopsProductionEmitsATerminalStateAndAllowsRestart() throws {
    let events = EventCollector()
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH) { events.add($0) }
    let (manifest, dims) = try garment()
    let src = try source(framesPerSegment: 5)
    XCTAssertTrue(s.load(src, manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertTrue(s.start())

    var produced = 0
    while s.advance() { produced += 1 }

    XCTAssertEqual(produced, src.frameCount, "every frame in the source must be produced exactly once")
    XCTAssertEqual(s.currentState(), .eof)
    XCTAssertFalse(s.advance(), "EOF must stop frame production")
    XCTAssertTrue(events.events.contains { $0.state == .eof }, "EOF must be emitted as a state event")

    // Not a silent loop: it stopped and stayed stopped until asked again.
    XCTAssertTrue(s.restart())
    XCTAssertEqual(s.currentState(), .playing)
    var again = 0
    while s.advance() { again += 1 }
    XCTAssertEqual(again, src.frameCount, "restart must replay the whole source")
    XCTAssertEqual(s.currentState(), .eof)
  }

  func testRapidStartStopCyclesAreSafe() throws {
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH)
    let (manifest, dims) = try garment()
    XCTAssertTrue(s.load(try source(framesPerSegment: 3), manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    for _ in 0..<50 {
      XCTAssertTrue(s.start())
      _ = s.advance()
      XCTAssertTrue(s.stop())
    }
    XCTAssertEqual(s.currentState(), .stopped)
    XCTAssertEqual(s.slot.depth, 0, "stop must empty the slot")
  }

  func testDisposeDuringPlaybackStopsProductionAndEmitsNothingFurther() throws {
    let events = EventCollector()
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH) { events.add($0) }
    let (manifest, dims) = try garment()
    XCTAssertTrue(s.load(try source(), manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertTrue(s.start())
    for _ in 0..<5 { _ = s.advance() }

    let before = events.events.count
    XCTAssertTrue(s.dispose())
    XCTAssertEqual(events.events.count, before + 1, "dispose must emit exactly one terminal event")
    XCTAssertEqual(events.events.last?.state, .disposed)

    XCTAssertFalse(s.advance(), "no frame may be produced after dispose")
    XCTAssertEqual(s.slot.depth, 0, "dispose must release the pending snapshot")
    XCTAssertNil(s.consumeForRender(), "no snapshot may be readable after dispose")

    // Every post-dispose command is a refused no-op, and none of them emits.
    let afterDispose = events.events.count
    XCTAssertFalse(s.start()); XCTAssertFalse(s.pause()); XCTAssertFalse(s.resume())
    XCTAssertFalse(s.stop()); XCTAssertFalse(s.restart()); XCTAssertFalse(s.dispose())
    XCTAssertFalse(s.load(try source(), manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertEqual(events.events.count, afterDispose, "no event may fire after the terminal event")
  }

  /// `advance()` is a total, non-throwing function by design (matching the
  /// Kotlin source's own "never throws" contract), so unlike Android's
  /// try/catch-around-arbitrary-exceptions version of this test, there is no
  /// catchable failure mode to assert absent here -- a genuine memory-safety
  /// violation would be a fatal trap, not a value this test could observe
  /// and report. What IS meaningfully asserted: the session reaches a clean,
  /// consistent DISPOSED state with no dangling geometry after a dispose()
  /// that races an actively-producing background thread.
  func testDisposeIsSafeWhileAProducerThreadIsRunning() throws {
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH)
    let (manifest, dims) = try garment()
    XCTAssertTrue(s.load(try source(framesPerSegment: 2000), manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertTrue(s.start())

    let stopped: LockedBox<Bool> = NSLock.locked(false)
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async {
      while !stopped.get() { _ = s.advance() }
      done.signal()
    }
    Thread.sleep(forTimeInterval: 0.06)
    s.dispose()
    stopped.set(true)
    XCTAssertEqual(done.wait(timeout: .now() + 5), .success, "producer thread did not settle")

    XCTAssertEqual(s.currentState(), .disposed)
    XCTAssertEqual(s.slot.depth, 0)
  }

  // MARK: - Backpressure

  /// A NON-VACUOUS overload test: the producer runs faster than the consumer
  /// and must provably drop stale frames while the slot stays depth-1.
  func testProducerOutrunningConsumerDropsStaleFramesAndStaysBounded() throws {
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH)
    let (manifest, dims) = try garment()
    let src = try source(framesPerSegment: 300)
    XCTAssertTrue(s.load(src, manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertTrue(s.start())

    // Consume only every 10th produced frame -- a renderer an order of magnitude slower than production.
    var rendered = 0
    var produced = 0
    while s.advance() {
      produced += 1
      if produced % 10 == 0, s.consumeForRender() != nil { rendered += 1 }
      XCTAssertLessThanOrEqual(s.slot.depth, 1, "the latest-state slot must never queue")
    }

    let stats = s.stats()
    XCTAssertEqual(produced, src.frameCount)
    XCTAssertGreaterThan(stats.dropped, 0, "BACKPRESSURE TEST INVALID: no frame was dropped")
    XCTAssertGreaterThan(stats.produced, stats.rendered, "more frames must be produced than rendered")
    XCTAssertEqual(stats.maxSlotDepth, 1, "max slot depth must stay bounded at 1")
    XCTAssertEqual(stats.produced, stats.rendered + stats.dropped + Int64(s.slot.depth), "every produced frame must be either rendered or counted as dropped")
    XCTAssertGreaterThan(rendered, 0, "the renderer must still have seen frames")

    writeEvidence("backpressure-deterministic-ios.json", """
    {"mode":"deterministic-slow-consumer","sourceFrames":\(src.frameCount),"produced":\(stats.produced),"rendered":\(stats.rendered),"dropped":\(stats.dropped),"maxSlotDepth":\(stats.maxSlotDepth),"refused":\(stats.refused),"consumeEveryNthFrame":10,"accountingInvariant":"produced == rendered + dropped + depth","accountingHolds":\(stats.produced == stats.rendered + stats.dropped + Int64(s.slot.depth))}
    """)
  }

  /// The same claim under real concurrency: an independent producer queue
  /// must never wait for the renderer.
  func testProducerClockIsIndependentOfRenderCadence() throws {
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH)
    let (manifest, dims) = try garment()
    XCTAssertTrue(s.load(try source(framesPerSegment: 5000), manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertTrue(s.start())

    let renderedCount = NSLock.locked(Int64(0))
    let stop = NSLock.locked(false)
    let producerDone = DispatchSemaphore(value: 0)

    DispatchQueue.global(qos: .userInitiated).async {
      while !stop.get(), s.advance() { /* free-running */ }
      producerDone.signal()
    }
    DispatchQueue.global(qos: .utility).async {
      while !stop.get() {
        if s.consumeForRender() != nil { renderedCount.set(renderedCount.get() + 1) }
        Thread.sleep(forTimeInterval: 0.005) // a deliberately slow renderer
      }
    }

    Thread.sleep(forTimeInterval: 0.25)
    stop.set(true)
    _ = producerDone.wait(timeout: .now() + 5)

    let stats = s.stats()
    XCTAssertGreaterThan(stats.produced, 0, "producer produced nothing")
    XCTAssertGreaterThan(stats.produced, renderedCount.get() * 2, "producer appears coupled to the renderer: produced=\(stats.produced) rendered=\(renderedCount.get())")
    XCTAssertGreaterThan(stats.dropped, 0, "no frame was dropped under a slow renderer")
    XCTAssertEqual(stats.maxSlotDepth, 1, "slot depth must stay bounded under real concurrency")

    writeEvidence("backpressure-concurrent-ios.json", """
    {"mode":"free-running-producer-thread-vs-5ms-consumer","wallClockMs":250,"produced":\(stats.produced),"rendered":\(renderedCount.get()),"dropped":\(stats.dropped),"maxSlotDepth":\(stats.maxSlotDepth),"producerToRendererRatio":\(Double(stats.produced) / Double(max(1, renderedCount.get())))}
    """)
  }

  private func writeEvidence(_ name: String, _ contents: String) {
    let dir = GoldenFixtures.moduleRoot.appendingPathComponent("build/conformance")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? contents.write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
  }

  // MARK: - Product switching during replay

  func testSwitchingGarmentMidReplayTakesEffectWithoutRestartAndLeavesNoStaleState() throws {
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH)
    let (a, aDims) = try garment("n1b-fixture")
    let (b, bDims) = try garment("n1c-asym-fixture")
    XCTAssertTrue(s.load(try source(framesPerSegment: 40), manifest: a, textureWidth: aDims.0, textureHeight: aDims.1))
    XCTAssertTrue(s.start())

    for _ in 0..<10 { _ = s.advance() }
    guard let underA = s.consumeForRender() else { return XCTFail() }
    XCTAssertEqual(underA.activeAssetId, a.productId)

    XCTAssertTrue(s.selectGarment(b, textureWidth: bDims.0, textureHeight: bDims.1))
    XCTAssertEqual(s.currentState(), .playing, "a switch must not restart replay")
    XCTAssertEqual(s.slot.depth, 0, "the pre-switch snapshot must not survive the switch")
    XCTAssertNil(s.consumeForRender(), "A's geometry must not be readable once B is active")

    // Every subsequent snapshot is B, and B is driven by the CURRENT pose.
    for _ in 0..<10 { _ = s.advance() }
    guard let underB = s.consumeForRender() else { return XCTFail() }
    XCTAssertEqual(underB.activeAssetId, b.productId)
    XCTAssertNotEqual(underB.bodyFrameId, underA.bodyFrameId, "B must be driven by a later frame than A was")

    // Switching back is symmetric.
    XCTAssertTrue(s.selectGarment(a, textureWidth: aDims.0, textureHeight: aDims.1))
    for _ in 0..<5 { _ = s.advance() }
    XCTAssertEqual(s.consumeForRender()?.activeAssetId, a.productId)
    XCTAssertEqual(s.currentState(), .playing)
  }

  func testSwitchingToAnInvalidGarmentFailsClosedWithoutCorruptingTheSession() throws {
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH)
    let (a, aDims) = try garment("n1b-fixture")
    let (b, _) = try garment("n1c-asym-fixture")
    XCTAssertTrue(s.load(try source(), manifest: a, textureWidth: aDims.0, textureHeight: aDims.1))
    XCTAssertTrue(s.start())
    for _ in 0..<3 { _ = s.advance() }

    XCTAssertFalse(s.selectGarment(b, textureWidth: 0, textureHeight: 0), "a garment with invalid dimensions must be refused")
    XCTAssertEqual(s.currentState(), .error)
    XCTAssertFalse(s.advance(), "an errored session must not keep producing")
    XCTAssertEqual(s.slot.depth, 0, "an errored session must hold no renderable geometry")
    XCTAssertTrue(s.dispose(), "dispose must still work from ERROR")
  }

  // MARK: - Replay + deformation

  func testGarmentMovesOverTimeAndStaysSynchronisedWithTheFrameIndex() throws {
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH)
    let (manifest, dims) = try garment()
    let src = try source(framesPerSegment: 30)
    XCTAssertTrue(s.load(src, manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertTrue(s.start())

    var seen: [GeometrySnapshot] = []
    var index = 0
    while s.advance() {
      guard let snapshot = s.consumeForRender() else { XCTFail("consuming immediately after producing must never miss a frame"); break }
      // The snapshot names the exact source frame it was computed from, so a
      // stale BodyFrame or an off-by-one is detectable, not merely unlikely.
      XCTAssertEqual(snapshot.bodyFrameId, "\(src.id)#\(index)")
      seen.append(snapshot)
      index += 1
    }

    XCTAssertEqual(seen.count, src.frameCount)
    let distinct = Set(seen.compactMap { $0.controlPoints["leftSleeve"] })
    XCTAssertGreaterThan(distinct.count, src.frameCount / 2, "the garment must actually move over the sequence, got \(distinct.count) distinct sleeve positions")
    for snapshot in seen {
      XCTAssertNil(snapshot.failure, "\(snapshot.bodyFrameId) refused during replay: \(snapshot.failure ?? "")")
      XCTAssertEqual(snapshot.validate(), [], "\(snapshot.bodyFrameId) invalid: \(snapshot.validate())")
    }
  }

  // MARK: - Privacy boundary

  /// The bridge must carry bounded state only. This asserts on the payload
  /// the event actually serializes, so adding a field to `ReplayEvent`
  /// without adding it to the allowlist fails here rather than silently
  /// widening the boundary.
  func testReplayEventsCarryOnlyBoundedStateAndNoFrameData() throws {
    let events = EventCollector()
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH) { events.add($0) }
    let (manifest, dims) = try garment()
    XCTAssertTrue(s.load(try source(framesPerSegment: 25), manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertTrue(s.start())
    while s.advance() { _ = s.consumeForRender() }
    s.dispose()

    let forbidden = ["frame", "frames", "bitmap", "image", "imagebytes", "pixels", "mask", "masks",
                      "landmark", "landmarks", "bodyframe", "pose", "controlpoints", "mesh", "meshvertices",
                      "texture", "buffer", "yuv", "rgba"]
    for event in events.events {
      let payload = event.toPayload()
      XCTAssertEqual(Set(payload.keys), ReplayEvent.allowedPayloadKeys, "ReplayEvent serialized a key outside the declared allowlist")
      let rendered = payload.map { "\($0.key)=\(String(describing: $0.value))" }.joined(separator: ",").lowercased()
      for key in forbidden {
        XCTAssertFalse(payload.keys.contains { $0.lowercased().contains(key) }, "replay event payload mentions '\(key)': \(rendered)")
      }
      // A payload value must never be a container that could smuggle bulk data.
      for value in payload.values {
        switch value {
        case nil, is String, is Bool, is Int, is Int64, is Double, is Float:
          continue
        default:
          XCTFail("replay event carried a non-scalar payload value: \(String(describing: value))")
        }
      }
    }
  }

  /// Events are per-TRANSITION, not per-FRAME. A runtime that emitted one
  /// event per frame would be a high-frequency channel regardless of what
  /// each event contained.
  func testEventCountIsBoundedByTransitionsNotByFrameCount() throws {
    let events = EventCollector()
    let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH) { events.add($0) }
    let (manifest, dims) = try garment()
    let src = try source(framesPerSegment: 200)
    XCTAssertTrue(s.load(src, manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
    XCTAssertTrue(s.start())
    while s.advance() { _ = s.consumeForRender() }
    s.dispose()

    XCTAssertGreaterThan(src.frameCount, 100, "the run must have been long enough to be meaningful")
    XCTAssertLessThanOrEqual(events.events.count, 10, "event count \(events.events.count) scales with frames (\(src.frameCount)), not transitions")
  }

  // MARK: - Resource discipline

  func testRepeatedStartRunStopDisposeCyclesDoNotGrowUnbounded() throws {
    let (manifest, dims) = try garment()
    var lastDepth = 0
    for _ in 0..<20 {
      let events = EventCollector()
      let s = LiveVtoReplaySession(canvasWidth: canvasW, canvasHeight: canvasH) { events.add($0) }
      XCTAssertTrue(s.load(try source(framesPerSegment: 10), manifest: manifest, textureWidth: dims.0, textureHeight: dims.1))
      XCTAssertTrue(s.start())
      while s.advance() { _ = s.consumeForRender() }
      _ = s.stop()
      _ = s.dispose()
      XCTAssertEqual(s.slot.depth, 0, "slot must be empty after dispose")
      XCTAssertLessThanOrEqual(events.events.count, 10, "event count must not grow across cycles")
      lastDepth = s.slot.depth
    }
    XCTAssertEqual(lastDepth, 0)
  }
}

/// Tiny lock-guarded box -- this test file's substitute for Kotlin's
/// `AtomicBoolean`/`AtomicLong`/`@Volatile`, matching the same
/// NSLock-over-atomics choice `LatestStateSlot` itself makes.
private final class LockedBox<T> {
  private let lock = NSLock()
  private var value: T
  init(_ value: T) { self.value = value }
  func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
  func set(_ newValue: T) { lock.lock(); value = newValue; lock.unlock() }
}

extension NSLock {
  fileprivate static func locked<T>(_ initial: T) -> LockedBox<T> { LockedBox(initial) }
}
