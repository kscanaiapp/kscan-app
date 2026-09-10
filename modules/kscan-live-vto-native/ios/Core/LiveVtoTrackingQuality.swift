import Foundation

/// The tracking-quality contract -- the Swift mirror of Android's
/// `LiveVtoTrackingQuality.kt`.
///
/// WHY THIS FILE EXISTS. Before it, `LIVE_VTO_EVENTS` declared
/// `trackingAcquired`/`trackingWeak`/`trackingLost`/`trackingRecovered` and
/// NEITHER platform ever emitted one -- the only `emitSessionEvent` call
/// sites in either render view were `ready`, `garmentLoaded` and
/// `fatalError`. The JS reducer had exhaustive handling for states nothing
/// could produce, and `VtoLivePanel` inferred "may the customer capture"
/// from `state === 'TRACKING'`, a state that could therefore never be
/// entered. The tracking contract was declared, not implemented.
///
/// DERIVED FROM FACTS, NEVER FROM A TIMER. Every input is something the
/// perception/geometry stack genuinely computed for a specific frame: did
/// the provider resolve a pose, what was the adapted `BodyFrame`'s own
/// `trackingConfidence`, did the rigid gate pass, which
/// `LiveVtoGeometryPipeline.Refusal` came back, and is a clean person frame
/// actually buffered right now. Time is used for exactly one thing --
/// staleness.
///
/// PURE ON PURPOSE. `ios/Core` is the SwiftPM `LiveVtoCore` target: zero
/// UIKit, zero ExpoModulesCore, zero MediaPipe (enforced by
/// `LiveVtoRuntimeBoundaryTests`), so the whole state matrix runs under
/// `swift test` on CI with no device -- the only certification available to
/// this lane.
///
/// PARITY IS EXECUTED, NOT ASSERTED. Every constant and every ordering below
/// matches the Kotlin file exactly, and
/// `__tests__/vtoLiveTrackingParity.test.js` plus
/// `Tests/LiveVtoCoreTests/LiveVtoTrackingQualityTests.swift` run BOTH
/// implementations against the SAME committed scenario fixture
/// (`goldens/tracking-quality-scenarios.json`). Two implementations that
/// merely look alike are not parity.

/// What one perception cycle actually produced.
public enum LiveVtoPerceptionOutcome: String, Equatable, Sendable {
  /// The provider inferred a pose AND the adapter mapped it to a `BodyFrame`.
  case poseResolved = "POSE_RESOLVED"
  /// The provider ran and produced no usable pose. Distinct from "no frame
  /// arrived": something looked and saw nobody.
  case poseRefused = "POSE_REFUSED"
}

/// The four phases the JS contract's tracking events describe.
public enum LiveVtoTrackingPhase: String, Equatable, Sendable {
  /// Session started; nothing resolved well enough yet. Emits nothing.
  case acquiring = "ACQUIRING"
  case acquired = "ACQUIRED"
  case weak = "WEAK"
  case lost = "LOST"
}

/// Coarse, NON-ANATOMICAL framing hint. Mirrors `LiveVtoGuidance` in
/// types/vtoLive.ts one-to-one, wire token for wire token.
public enum LiveVtoTrackingGuidance: String, Equatable, Sendable {
  case none = "none"
  case stepBack = "step_back"
  case stepCloser = "step_closer"
  case centerYourself = "center_yourself"
  case improveLighting = "improve_lighting"
  case holdStill = "hold_still"

  public var wireToken: String { rawValue }
}

/// One perception cycle's facts.
public struct LiveVtoTrackingObservation: Equatable, Sendable {
  public let monotonicMs: Int64
  public let outcome: LiveVtoPerceptionOutcome
  /// `BodyFrame.trackingConfidence`. 0 when no pose was resolved.
  public let trackingConfidence: Float
  /// `GeometrySnapshot.gatePassed`.
  public let geometryGatePassed: Bool
  /// `GeometrySnapshot.failure` -- a `LiveVtoGeometryPipeline.Refusal`, or nil.
  public let geometryFailure: String?
  /// Is a clean person frame buffered RIGHT NOW -- the same source
  /// `captureCleanFrame()` reads. "The camera object exists" is not this.
  public let personFrameAvailable: Bool

  public init(
    monotonicMs: Int64,
    outcome: LiveVtoPerceptionOutcome,
    trackingConfidence: Float,
    geometryGatePassed: Bool,
    geometryFailure: String?,
    personFrameAvailable: Bool
  ) {
    self.monotonicMs = monotonicMs
    self.outcome = outcome
    self.trackingConfidence = trackingConfidence
    self.geometryGatePassed = geometryGatePassed
    self.geometryFailure = geometryFailure
    self.personFrameAvailable = personFrameAvailable
  }
}

/// The tracking half of what a surface may render.
public struct LiveVtoTrackingSnapshot: Equatable, Sendable {
  public let phase: LiveVtoTrackingPhase
  public let confidence: Float
  public let guidance: LiveVtoTrackingGuidance
  /// THE CAPTURE AUTHORITY (mission section 14): session running + tracking
  /// sufficient + person frame available + no active invalidation. Recomputed
  /// from current facts on every observation rather than latched, so it goes
  /// false the instant any one of them stops holding.
  public let captureReady: Bool
}

/// A bridge-ready contract event. `name` is always a member of
/// `LIVE_VTO_EVENTS`; `payload` is always JSON-primitive and carries no
/// camera-derived geometry.
public struct LiveVtoTrackingEvent: Equatable {
  public let name: String
  public let payload: [String: Any]

  public static func == (lhs: LiveVtoTrackingEvent, rhs: LiveVtoTrackingEvent) -> Bool {
    guard lhs.name == rhs.name, lhs.payload.count == rhs.payload.count else { return false }
    for (key, value) in lhs.payload {
      guard let other = rhs.payload[key] else { return false }
      if let a = value as? Bool, let b = other as? Bool { if a != b { return false }; continue }
      if let a = value as? Double, let b = other as? Double { if a != b { return false }; continue }
      if let a = value as? String, let b = other as? String { if a != b { return false }; continue }
      return false
    }
    return true
  }
}

/// The hysteresis machine. NOT thread-safe by construction, deliberately:
/// every call site is the perception queue or the main queue holding the
/// view's own ordering, and a lock here would hide, not fix, a caller that
/// violated that.
public final class LiveVtoTrackingQualityMachine {
  /// FROZEN FOR THIS LANE, PENDING-RUNTIME CALIBRATION. Contract thresholds,
  /// not tuned device constants: no phone was available to the lane that
  /// wrote them, so nothing here was fitted to measured hardware behaviour.
  /// Identical to the Kotlin companion object, value for value.
  public static let strongConfidenceDefault: Float = 0.60
  public static let weakFloorConfidenceDefault: Float = 0.30
  public static let acquireStreakDefault: Int = 3
  public static let demoteStreakDefault: Int = 2
  public static let weakAfterMsDefault: Int64 = 400
  public static let lostAfterMsDefault: Int64 = 900
  public static let reEmitIntervalMsDefault: Int64 = 250

  private let strongConfidence: Float
  private let weakFloorConfidence: Float
  private let acquireStreak: Int
  private let demoteStreak: Int
  private let weakAfterMs: Int64
  private let lostAfterMs: Int64
  private let reEmitIntervalMs: Int64

  private var phase: LiveVtoTrackingPhase = .acquiring
  private var confidence: Float = 0
  private var guidance: LiveVtoTrackingGuidance = .none
  private var captureReady: Bool = false

  private var strongRun: Int = 0
  private var degradedRun: Int = 0
  private var lastResolvedMs: Int64?
  private var lastEmitMs: Int64?
  private var lastEmittedName: String?
  private var lastEmittedGuidance: LiveVtoTrackingGuidance?
  private var lastEmittedCaptureReady: Bool?

  public init(
    strongConfidence: Float = LiveVtoTrackingQualityMachine.strongConfidenceDefault,
    weakFloorConfidence: Float = LiveVtoTrackingQualityMachine.weakFloorConfidenceDefault,
    acquireStreak: Int = LiveVtoTrackingQualityMachine.acquireStreakDefault,
    demoteStreak: Int = LiveVtoTrackingQualityMachine.demoteStreakDefault,
    weakAfterMs: Int64 = LiveVtoTrackingQualityMachine.weakAfterMsDefault,
    lostAfterMs: Int64 = LiveVtoTrackingQualityMachine.lostAfterMsDefault,
    reEmitIntervalMs: Int64 = LiveVtoTrackingQualityMachine.reEmitIntervalMsDefault
  ) {
    self.strongConfidence = strongConfidence
    self.weakFloorConfidence = weakFloorConfidence
    self.acquireStreak = acquireStreak
    self.demoteStreak = demoteStreak
    self.weakAfterMs = weakAfterMs
    self.lostAfterMs = lostAfterMs
    self.reEmitIntervalMs = reEmitIntervalMs
  }

  public func snapshot() -> LiveVtoTrackingSnapshot {
    LiveVtoTrackingSnapshot(
      phase: phase, confidence: confidence, guidance: guidance, captureReady: captureReady
    )
  }

  /// Resets to the pre-session position. Called on start/stop/dispose and on
  /// every garment load, so a new epoch cannot inherit the previous one's
  /// ACQUIRED and let a capture control go live before anything was seen.
  public func reset() {
    phase = .acquiring
    confidence = 0
    guidance = .none
    captureReady = false
    strongRun = 0
    degradedRun = 0
    lastResolvedMs = nil
    lastEmitMs = nil
    lastEmittedName = nil
    lastEmittedGuidance = nil
    lastEmittedCaptureReady = nil
  }

  /// One perception cycle. Returns the contract event to emit, or nil.
  @discardableResult
  public func observe(_ observation: LiveVtoTrackingObservation) -> LiveVtoTrackingEvent? {
    let finiteConfidence = observation.trackingConfidence.isFinite
    let strong = observation.outcome == .poseResolved
      && observation.geometryGatePassed
      && observation.geometryFailure == nil
      && finiteConfidence
      && observation.trackingConfidence >= strongConfidence

    if observation.outcome == .poseResolved {
      lastResolvedMs = observation.monotonicMs
      confidence = finiteConfidence ? min(max(observation.trackingConfidence, 0), 1) : 0
    } else {
      confidence = 0
    }

    if strong {
      strongRun += 1
      degradedRun = 0
    } else {
      degradedRun += 1
      strongRun = 0
    }

    let nextPhase: LiveVtoTrackingPhase
    if strong && strongRun >= acquireStreak {
      nextPhase = .acquired
    } else if strong {
      // A strong frame short of the acquire streak never DOWNGRADES an
      // already-acquired session -- flicker in either direction is what the
      // streaks exist to prevent.
      nextPhase = phase
    } else if staleFor(observation.monotonicMs) >= lostAfterMs {
      nextPhase = .lost
    } else if degradedRun >= demoteStreak {
      nextPhase = phase == .lost ? .lost : .weak
    } else {
      nextPhase = phase
    }

    // Guidance is derived AFTER the phase, not before it. A single degraded
    // frame inside an ACQUIRED session is noise the hysteresis absorbs, and
    // telling a tracked customer to "center yourself" because of one dropped
    // inference is the kind of jitter that makes a surface feel broken. LOST
    // has no framing instruction either: the copy table owns that message,
    // and both the observation path and the staleness path have to agree on
    // it or the two would announce different things for the same condition.
    let nextGuidance: LiveVtoTrackingGuidance
    if nextPhase == .acquired || nextPhase == .lost {
      nextGuidance = .none
    } else if strong {
      nextGuidance = .none
    } else {
      nextGuidance = guidanceFor(observation)
    }

    return commit(
      nextPhase: nextPhase,
      nextGuidance: nextGuidance,
      personFrameAvailable: observation.personFrameAvailable,
      monotonicMs: observation.monotonicMs
    )
  }

  /// A heartbeat with no new perception result. It NEVER promotes and never
  /// touches the streaks: its only job is to make a session that has stopped
  /// seeing anybody say so, instead of holding a stale "Live" indefinitely.
  @discardableResult
  public func tick(monotonicMs: Int64, personFrameAvailable: Bool) -> LiveVtoTrackingEvent? {
    let stale = staleFor(monotonicMs)
    let nextPhase: LiveVtoTrackingPhase
    if lastResolvedMs == nil {
      nextPhase = phase
    } else if stale >= lostAfterMs {
      nextPhase = .lost
    } else if stale >= weakAfterMs && phase == .acquired {
      nextPhase = .weak
    } else {
      nextPhase = phase
    }

    let nextGuidance: LiveVtoTrackingGuidance
    if nextPhase == .lost {
      nextGuidance = .none
    } else if nextPhase == .weak && phase == .acquired {
      nextGuidance = .holdStill
    } else {
      nextGuidance = guidance
    }

    if nextPhase != phase {
      confidence = 0
      // DEMOTION CLEARS THE STREAKS. Without this, a session that went LOST
      // while `strongRun` still held `acquireStreak` from before the loss
      // re-acquired on the very FIRST strong frame afterwards -- ten minutes
      // of darkness, one good frame, straight back to "Ready" and a live
      // capture control. Re-acquisition has to earn the same sustained
      // evidence the original acquisition did. Found by the shared
      // cross-platform fixture, not by inspection.
      strongRun = 0
      degradedRun = 0
    }
    return commit(
      nextPhase: nextPhase,
      nextGuidance: nextGuidance,
      personFrameAvailable: personFrameAvailable,
      monotonicMs: monotonicMs
    )
  }

  /// Milliseconds since a pose was last resolved. Before the FIRST resolved
  /// pose there is no "since" -- returning 0 rather than a huge number keeps
  /// a session that has simply not started seeing anybody yet in ACQUIRING
  /// instead of being declared LOST on its very first tick.
  private func staleFor(_ monotonicMs: Int64) -> Int64 {
    guard let last = lastResolvedMs else { return 0 }
    return max(monotonicMs - last, 0)
  }

  private func guidanceFor(_ observation: LiveVtoTrackingObservation) -> LiveVtoTrackingGuidance {
    if observation.outcome == .poseRefused { return .stepBack }
    switch observation.geometryFailure {
    case LiveVtoGeometryPipeline.Refusal.missingShoulders,
         LiveVtoGeometryPipeline.Refusal.missingHips:
      return .stepBack
    case LiveVtoGeometryPipeline.Refusal.degenerateShoulderSpan:
      return .stepCloser
    case LiveVtoGeometryPipeline.Refusal.degenerateBodyAxis:
      return .centerYourself
    case LiveVtoGeometryPipeline.Refusal.nonFiniteLandmark,
         LiveVtoGeometryPipeline.Refusal.nonFiniteGeometry:
      return .holdStill
    // A garment-side refusal is not something the customer can stand
    // differently to fix, so it produces no framing instruction at all.
    case LiveVtoGeometryPipeline.Refusal.missingGarmentControlPoints,
         LiveVtoGeometryPipeline.Refusal.degenerateGarmentSpan:
      return .none
    default:
      if observation.trackingConfidence.isFinite && observation.trackingConfidence < weakFloorConfidence {
        // Seen, but barely. The most common recoverable cause on a phone.
        return .improveLighting
      }
      return .holdStill
    }
  }

  /// Applies the new position and decides whether it is worth an event. A
  /// phase CHANGE always emits; a repeat of the same phase emits only when
  /// something a surface would render changed AND at most once per
  /// `reEmitIntervalMs`.
  private func commit(
    nextPhase: LiveVtoTrackingPhase,
    nextGuidance: LiveVtoTrackingGuidance,
    personFrameAvailable: Bool,
    monotonicMs: Int64
  ) -> LiveVtoTrackingEvent? {
    let previousPhase = phase
    let nextCaptureReady = nextPhase == .acquired && personFrameAvailable

    phase = nextPhase
    guidance = nextGuidance
    captureReady = nextCaptureReady

    let name: String
    switch nextPhase {
    case .acquiring:
      return nil
    case .acquired:
      name = (previousPhase == .weak || previousPhase == .lost) ? "trackingRecovered" : "trackingAcquired"
    case .weak:
      name = "trackingWeak"
    case .lost:
      name = "trackingLost"
    }

    let phaseChanged = nextPhase != previousPhase
    if !phaseChanged {
      let readinessChanged = lastEmittedCaptureReady != nextCaptureReady
      let guidanceChanged = lastEmittedGuidance != nextGuidance
      if !readinessChanged && !guidanceChanged { return nil }
      // COALESCING APPLIES TO GUIDANCE ONLY, NEVER TO READINESS.
      //
      // Capture readiness is an authority a control is bound to, and a
      // throttle on it is wrong in BOTH directions: delaying a withdrawal
      // leaves an enabled button that would capture nothing, and delaying a
      // grant leaves a disabled button on a session that is ready. Guidance
      // is the noisy signal, and the one an accessibility live region would
      // otherwise announce per inference, so it is the one throttled.
      if !readinessChanged, let since = lastEmitMs, monotonicMs - since < reEmitIntervalMs {
        return nil
      }
    }

    lastEmitMs = monotonicMs
    lastEmittedName = name
    lastEmittedGuidance = nextGuidance
    lastEmittedCaptureReady = nextCaptureReady
    return LiveVtoTrackingEvent(name: name, payload: payloadFor(name, nextGuidance, nextCaptureReady))
  }

  /// The bridge payload. Shapes match `LiveVtoEventPayloads` in
  /// types/vtoLive.ts exactly, plus the ADDITIVE `captureReady` field every
  /// tracking event now carries.
  private func payloadFor(
    _ name: String,
    _ nextGuidance: LiveVtoTrackingGuidance,
    _ nextCaptureReady: Bool
  ) -> [String: Any] {
    switch name {
    case "trackingWeak":
      return [
        "confidence": Double(confidence),
        "guidance": nextGuidance.wireToken,
        "captureReady": nextCaptureReady,
      ]
    case "trackingLost":
      return ["captureReady": nextCaptureReady]
    default:
      return ["confidence": Double(confidence), "captureReady": nextCaptureReady]
    }
  }
}
