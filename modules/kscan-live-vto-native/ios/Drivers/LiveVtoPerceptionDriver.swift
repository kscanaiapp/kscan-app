import Foundation
import os.log

private let perceptionLog = OSLog(subsystem: "com.kscanai.app.livevto", category: "perception")

/// Owns BOTH clocks perception needs, on two threads independent of the main
/// thread and independent of EACH OTHER. Field-for-field port of Android's
/// `LiveVtoPerceptionDriver.kt`.
///
///   FRAME PRODUCER  (fixed-cadence clock, like the replay clock)
///          |
///          v  submitFrame() -> LatestStateSlot<PerceptionInputFrame>
///          |
///   PERCEPTION LOOP  (runs as fast as REAL inference allows -- NOT a fixed
///                      period; real MediaPipe inference latency is what
///                      creates genuine backpressure here, not a simulated
///                      delay)
///          |
///          v  publish() -> LatestStateSlot<GeometrySnapshot>
///          |
///   UIKit draw thread (consumes geometrySlot, unrelated to either clock)
///
/// Neither thread is the main thread. Rasterization stays on the view's own
/// draw call, per the same reasoning as `LiveVtoReplayDriver`.
public final class LiveVtoPerceptionDriver {
  public static let producerThreadName = "kscan-live-vto-perception-producer"
  public static let perceptionThreadName = "kscan-live-vto-perception-infer"
  /// Same nominal cadence as the replay clock; not tuned to any device.
  public static let defaultProducerPeriodSeconds: TimeInterval = 0.033

  private let session: LiveVtoPerceptionSession
  private let frameSource: () -> PerceptionInputFrame
  private let producerPeriodSeconds: TimeInterval

  private let producerQueue = DispatchQueue(label: LiveVtoPerceptionDriver.producerThreadName, qos: .userInitiated)
  private var perceptionThread: Thread?

  private let runningLock = NSLock()
  private var running = false
  private var generation = 0
  private var perceptionLoopRunning = false

  public init(
    session: LiveVtoPerceptionSession, frameSource: @escaping () -> PerceptionInputFrame,
    producerPeriodSeconds: TimeInterval = LiveVtoPerceptionDriver.defaultProducerPeriodSeconds
  ) {
    self.session = session
    self.frameSource = frameSource
    self.producerPeriodSeconds = producerPeriodSeconds
  }

  public func start() {
    runningLock.lock()
    guard !running else { runningLock.unlock(); return }
    running = true
    perceptionLoopRunning = true
    let myGeneration = generation
    runningLock.unlock()

    producerQueue.async { [weak self] in self?.producerTick(generation: myGeneration) }

    let thread = Thread { [weak self] in self?.perceptionLoop(generation: myGeneration) }
    thread.name = Self.perceptionThreadName
    thread.qualityOfService = .userInitiated
    perceptionThread = thread
    thread.start()
  }

  private func producerTick(generation myGeneration: Int) {
    runningLock.lock()
    guard running, generation == myGeneration else { runningLock.unlock(); return }
    runningLock.unlock()

    _ = session.submitFrame(frameSource())

    runningLock.lock()
    guard running, generation == myGeneration else { runningLock.unlock(); return }
    runningLock.unlock()
    producerQueue.asyncAfter(deadline: .now() + producerPeriodSeconds) { [weak self] in self?.producerTick(generation: myGeneration) }
  }

  /// A tight loop, not a fixed-period schedule: real inference latency IS the
  /// pacing. When there is nothing new to process, back off briefly rather
  /// than busy-spinning.
  private func perceptionLoop(generation myGeneration: Int) {
    while true {
      runningLock.lock()
      let shouldContinue = perceptionLoopRunning && generation == myGeneration
      runningLock.unlock()
      if !shouldContinue { break }

      let didWork = session.runOneInferenceStep()
      if !didWork { Thread.sleep(forTimeInterval: 0.005) }
    }
  }

  public func stop() {
    runningLock.lock()
    guard running else { runningLock.unlock(); return }
    running = false
    perceptionLoopRunning = false
    generation += 1
    runningLock.unlock()
    perceptionThread = nil
  }

  public var isRunning: Bool { runningLock.lock(); defer { runningLock.unlock() }; return running }
}
