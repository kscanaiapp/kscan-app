import Foundation
import os.log

/// Owns the replay CLOCK -- the one thing `LiveVtoReplaySession` deliberately
/// does not own, so the session stays a pure, host-testable state machine.
/// Field-for-field port of Android's `LiveVtoReplayDriver.kt`.
///
/// ── Thread topology ──────────────────────────────────────────────────────
///
///   kscan-live-vto-replay   (this class, one serial background queue)
///       frame acquisition from the replay source
///       BodyFrame production
///       deformation / geometry compute (LiveVtoGeometryPipeline)
///       publish into LatestStateSlot
///
///   UIKit draw thread
///       LiveVtoRenderView.draw(_:) -> slot.peek() -> Core Graphics
///
///   Bridge / event dispatch
///       ReplayEvent callbacks, on the replay queue; the module marshals
///       them onward. State transitions only -- never per frame.
///
/// NOTHING in the first group runs on the main thread. Rasterization runs on
/// the view's own draw call, which is correct and required for UIKit's
/// rendering model -- what must stay off it is production and deformation,
/// and both live here.
///
/// This class deliberately does NOT use a repeating `DispatchSourceTimer`
/// (which schedules at a FIXED RATE and can fire a burst of catch-up ticks
/// after a slow one -- exactly the queueing behavior a fixed-DELAY clock
/// forbids). Instead each tick reschedules itself `framePeriod` after it
/// FINISHES, matching Android's deliberate choice of
/// `scheduleWithFixedDelay` over `scheduleAtFixedRate`.
public final class LiveVtoReplayDriver {
  public static let threadName = "kscan-live-vto-replay"

  /// ~30 production ticks per second. Deliberately NOT tuned to any device
  /// or simulator: this exists to prove the architecture drops rather than
  /// queues; real cadence is re-measured against real perception and camera
  /// workloads once camera work begins.
  public static let defaultFramePeriodSeconds: TimeInterval = 0.033

  private let session: LiveVtoReplaySession
  private let framePeriodSeconds: TimeInterval
  private let queue = DispatchQueue(label: LiveVtoReplayDriver.threadName, qos: .userInitiated)
  private let runningLock = NSLock()
  private var running = false
  /// Bumped on every `stop()`; a scheduled tick checks its own generation
  /// before running and reschedules only if unchanged, so a `stop()` racing
  /// an in-flight `asyncAfter` cannot resurrect the clock.
  private var generation: Int = 0

  public init(session: LiveVtoReplaySession, framePeriodSeconds: TimeInterval = LiveVtoReplayDriver.defaultFramePeriodSeconds) {
    self.session = session
    self.framePeriodSeconds = framePeriodSeconds
  }

  /// Starts the clock. Idempotent -- a second call while running is a no-op.
  public func start() {
    runningLock.lock()
    guard !running else { runningLock.unlock(); return }
    running = true
    let myGeneration = generation
    runningLock.unlock()
    queue.async { [weak self] in self?.tick(generation: myGeneration) }
  }

  private func tick(generation myGeneration: Int) {
    runningLock.lock()
    guard running, generation == myGeneration else { runningLock.unlock(); return }
    runningLock.unlock()

    _ = session.advance()

    runningLock.lock()
    guard running, generation == myGeneration else { runningLock.unlock(); return }
    runningLock.unlock()
    queue.asyncAfter(deadline: .now() + framePeriodSeconds) { [weak self] in self?.tick(generation: myGeneration) }
  }

  /// Stops the clock. Returns once no further tick will run for the current generation.
  public func stop() {
    runningLock.lock()
    guard running else { runningLock.unlock(); return }
    running = false
    generation += 1
    runningLock.unlock()
  }

  public var isRunning: Bool { runningLock.lock(); defer { runningLock.unlock() }; return running }
}
