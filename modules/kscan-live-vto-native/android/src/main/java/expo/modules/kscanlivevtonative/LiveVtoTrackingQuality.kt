package expo.modules.kscanlivevtonative

/**
 * The tracking-quality contract: perception/geometry FACTS -> the four
 * high-level tracking states `types/vtoLive.ts` already governs, plus the
 * capture-readiness authority the customer surface binds its capture control
 * to.
 *
 * WHY THIS FILE EXISTS. Before it, `LIVE_VTO_EVENTS` declared
 * `trackingAcquired`/`trackingWeak`/`trackingLost`/`trackingRecovered` and
 * NEITHER platform ever emitted one -- the only `emitSessionEvent` call
 * sites in either render view were `ready`, `garmentLoaded` and
 * `fatalError`. The JS reducer had exhaustive handling for states nothing
 * could produce, and `VtoLivePanel` inferred "may the customer capture" from
 * `state === 'TRACKING'`, a state that could therefore never be entered. The
 * tracking contract was declared, not implemented.
 *
 * DERIVED FROM FACTS, NEVER FROM A TIMER. Every input below is something the
 * perception/geometry stack genuinely computed for a specific frame:
 *
 *   - whether the provider resolved a pose at all       (PerceptionResult)
 *   - the adapted BodyFrame's own `trackingConfidence`  (LiveVtoBodyFrame)
 *   - whether the rigid gate passed                     (GeometrySnapshot.gatePassed)
 *   - which refusal the geometry pipeline returned      (GeometrySnapshot.failure)
 *   - whether a clean person frame is actually buffered (the same source
 *     `captureCleanFrame()` reads -- not "a camera object exists")
 *
 * There is deliberately no cosmetic progress, no fixed "acquiring for two
 * seconds then say Ready" animation, and no random state. TIME IS USED FOR
 * EXACTLY ONE THING -- staleness: a session that has not resolved a pose for
 * [LOST_AFTER_MS] is genuinely not tracking anybody, and saying otherwise
 * would be the lie this file exists to prevent.
 *
 * PURE ON PURPOSE. Zero Android imports (RuntimeBoundaryTest enforces it),
 * no clock of its own -- the caller supplies a monotonic millisecond stamp --
 * and no I/O. The entire state matrix, including every hysteresis and
 * staleness ordering, therefore runs on the JVM with no device, which is the
 * only way this lane can certify it at all.
 *
 * MIRRORED, NOT SHARED. `ios/Core/LiveVtoTrackingQuality.swift` is a
 * field-for-field port with the SAME constants and the SAME ordering, and
 * `__tests__/vtoLiveTrackingParity.test.js` runs BOTH against the shared
 * scenario fixture `goldens/tracking-quality-scenarios.json`. Two
 * implementations that merely look similar are not parity; a fixture both
 * are executed against is.
 */

/** What one perception cycle actually produced. */
enum class LiveVtoPerceptionOutcome {
  /** The provider inferred a pose AND the adapter mapped it to a BodyFrame. */
  POSE_RESOLVED,

  /** The provider ran and did not produce a usable pose (`NoPose`,
   *  `Failure`, `NoUsablePose`, `InvalidProviderOutput`). Distinct from "no
   *  frame arrived": something looked and saw nobody. */
  POSE_REFUSED,
}

/** The four phases the JS contract's tracking events describe. */
enum class LiveVtoTrackingPhase {
  /** Session started; nothing has been resolved well enough yet. Emits nothing. */
  ACQUIRING,
  ACQUIRED,
  WEAK,
  LOST,
}

/**
 * Coarse, NON-ANATOMICAL framing hint. Mirrors `LiveVtoGuidance` in
 * types/vtoLive.ts one-to-one, wire token for wire token -- a bounding box
 * would be body data; "step back" is guidance.
 */
enum class LiveVtoTrackingGuidance(val wireToken: String) {
  NONE("none"),
  STEP_BACK("step_back"),
  STEP_CLOSER("step_closer"),
  CENTER_YOURSELF("center_yourself"),
  IMPROVE_LIGHTING("improve_lighting"),
  HOLD_STILL("hold_still"),
}

/**
 * One perception cycle's facts. Constructed by
 * `LiveVtoPerceptionSession.runOneInferenceStep`, the only place that knows
 * all of them at once.
 */
data class LiveVtoTrackingObservation(
  val monotonicMs: Long,
  val outcome: LiveVtoPerceptionOutcome,
  /** `BodyFrame.trackingConfidence`. 0 when no pose was resolved. */
  val trackingConfidence: Float,
  /** `GeometrySnapshot.gatePassed`. */
  val geometryGatePassed: Boolean,
  /** `GeometrySnapshot.failure` -- a `LiveVtoGeometryPipeline.Refusal`, or null. */
  val geometryFailure: String?,
  /** Is a clean person frame buffered RIGHT NOW -- the same source
   *  `captureCleanFrame()` reads. "The camera object exists" is not this. */
  val personFrameAvailable: Boolean,
)

/** The tracking half of what a surface may render. */
data class LiveVtoTrackingSnapshot(
  val phase: LiveVtoTrackingPhase,
  val confidence: Float,
  val guidance: LiveVtoTrackingGuidance,
  /**
   * THE CAPTURE AUTHORITY (mission section 14).
   *
   *   session running + tracking sufficient + person frame available
   *   + no active invalidation  ->  true
   *
   * False the instant any one of those stops holding, because it is
   * RECOMPUTED from the current facts on every observation rather than
   * latched. A capture control bound to this cannot offer a capture that
   * would produce nothing.
   */
  val captureReady: Boolean,
)

/** A bridge-ready contract event, or nothing. `name` is always a member of
 *  `LIVE_VTO_EVENTS`; `payload` is always JSON-primitive and carries no
 *  camera-derived geometry (see `FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS`). */
data class LiveVtoTrackingEvent(val name: String, val payload: Map<String, Any?>)

/**
 * The hysteresis machine.
 *
 * NOT thread-safe by construction, deliberately: every call site is the
 * perception thread or the main thread holding the view's own ordering, and
 * a lock here would hide, not fix, a caller that violated that.
 */
class LiveVtoTrackingQualityMachine(
  private val strongConfidence: Float = STRONG_CONFIDENCE,
  private val weakFloorConfidence: Float = WEAK_FLOOR_CONFIDENCE,
  private val acquireStreak: Int = ACQUIRE_STREAK,
  private val demoteStreak: Int = DEMOTE_STREAK,
  private val weakAfterMs: Long = WEAK_AFTER_MS,
  private val lostAfterMs: Long = LOST_AFTER_MS,
  private val reEmitIntervalMs: Long = RE_EMIT_INTERVAL_MS,
) {
  private var phase: LiveVtoTrackingPhase = LiveVtoTrackingPhase.ACQUIRING
  private var confidence: Float = 0f
  private var guidance: LiveVtoTrackingGuidance = LiveVtoTrackingGuidance.NONE
  private var captureReady: Boolean = false

  private var strongRun: Int = 0
  private var degradedRun: Int = 0
  private var lastResolvedMs: Long? = null
  private var lastEmitMs: Long? = null
  private var lastEmittedName: String? = null
  private var lastEmittedGuidance: LiveVtoTrackingGuidance? = null
  private var lastEmittedCaptureReady: Boolean? = null

  fun snapshot(): LiveVtoTrackingSnapshot =
    LiveVtoTrackingSnapshot(phase, confidence, guidance, captureReady)

  /**
   * Resets to the pre-session position. Called on start/stop/dispose and on
   * every garment load, so a new epoch cannot inherit the previous one's
   * ACQUIRED and let a capture control go live before anything was seen.
   */
  fun reset() {
    phase = LiveVtoTrackingPhase.ACQUIRING
    confidence = 0f
    guidance = LiveVtoTrackingGuidance.NONE
    captureReady = false
    strongRun = 0
    degradedRun = 0
    lastResolvedMs = null
    lastEmitMs = null
    lastEmittedName = null
    lastEmittedGuidance = null
    lastEmittedCaptureReady = null
  }

  /** One perception cycle. Returns the contract event to emit, or null. */
  fun observe(observation: LiveVtoTrackingObservation): LiveVtoTrackingEvent? {
    val finiteConfidence = observation.trackingConfidence.isFinite()
    val strong = observation.outcome == LiveVtoPerceptionOutcome.POSE_RESOLVED &&
      observation.geometryGatePassed &&
      observation.geometryFailure == null &&
      finiteConfidence &&
      observation.trackingConfidence >= strongConfidence

    if (observation.outcome == LiveVtoPerceptionOutcome.POSE_RESOLVED) {
      lastResolvedMs = observation.monotonicMs
      confidence = if (finiteConfidence) observation.trackingConfidence.coerceIn(0f, 1f) else 0f
    } else {
      confidence = 0f
    }

    if (strong) {
      strongRun += 1
      degradedRun = 0
    } else {
      degradedRun += 1
      strongRun = 0
    }

    val nextPhase = when {
      strong && strongRun >= acquireStreak -> LiveVtoTrackingPhase.ACQUIRED
      // A strong frame short of the acquire streak never DOWNGRADES an
      // already-acquired session -- flicker in either direction is what the
      // streaks exist to prevent.
      strong -> phase
      staleFor(observation.monotonicMs) >= lostAfterMs -> LiveVtoTrackingPhase.LOST
      degradedRun >= demoteStreak ->
        if (phase == LiveVtoTrackingPhase.LOST) LiveVtoTrackingPhase.LOST else LiveVtoTrackingPhase.WEAK
      else -> phase
    }

    // Guidance is derived AFTER the phase, not before it. A single degraded
    // frame inside an ACQUIRED session is noise the hysteresis absorbs, and
    // telling a tracked customer to "center yourself" because of one dropped
    // inference is the kind of jitter that makes a surface feel broken. LOST
    // has no framing instruction either: the copy table owns that message,
    // and both the observation path and the staleness path have to agree on
    // it or the two would announce different things for the same condition.
    val nextGuidance = when {
      nextPhase == LiveVtoTrackingPhase.ACQUIRED || nextPhase == LiveVtoTrackingPhase.LOST ->
        LiveVtoTrackingGuidance.NONE
      strong -> LiveVtoTrackingGuidance.NONE
      else -> guidanceFor(observation)
    }

    return commit(nextPhase, nextGuidance, observation.personFrameAvailable, observation.monotonicMs)
  }

  /**
   * A heartbeat with no new perception result -- the camera produced nothing
   * this tick, or inference is still running. It NEVER promotes and never
   * touches the streaks: its only job is to make a session that has stopped
   * seeing anybody say so, instead of holding a stale "Live" indefinitely.
   */
  fun tick(monotonicMs: Long, personFrameAvailable: Boolean): LiveVtoTrackingEvent? {
    val stale = staleFor(monotonicMs)
    val nextPhase = when {
      lastResolvedMs == null -> phase
      stale >= lostAfterMs -> LiveVtoTrackingPhase.LOST
      stale >= weakAfterMs && phase == LiveVtoTrackingPhase.ACQUIRED -> LiveVtoTrackingPhase.WEAK
      else -> phase
    }
    val nextGuidance = when {
      nextPhase == LiveVtoTrackingPhase.LOST -> LiveVtoTrackingGuidance.NONE
      nextPhase == LiveVtoTrackingPhase.WEAK && phase == LiveVtoTrackingPhase.ACQUIRED ->
        LiveVtoTrackingGuidance.HOLD_STILL
      else -> guidance
    }
    if (nextPhase != phase) {
      confidence = 0f
      // DEMOTION CLEARS THE STREAKS. Without this, a session that went LOST
      // while `strongRun` still held ACQUIRE_STREAK from before the loss
      // re-acquired on the very FIRST strong frame afterwards -- ten minutes
      // of darkness, one good frame, straight back to "Ready" and a live
      // capture control. Re-acquisition has to earn the same sustained
      // evidence the original acquisition did. Found by the shared
      // cross-platform fixture (scenario "recovery after lost also announces
      // trackingRecovered"), not by inspection.
      strongRun = 0
      degradedRun = 0
    }
    return commit(nextPhase, nextGuidance, personFrameAvailable, monotonicMs)
  }

  /**
   * Milliseconds since a pose was last resolved. Before the FIRST resolved
   * pose there is no "since" -- returning 0 rather than a huge number is
   * what keeps a session that has simply not started seeing anybody yet in
   * ACQUIRING instead of being declared LOST on its very first tick.
   */
  private fun staleFor(monotonicMs: Long): Long {
    val last = lastResolvedMs ?: return 0L
    return (monotonicMs - last).coerceAtLeast(0L)
  }

  private fun guidanceFor(observation: LiveVtoTrackingObservation): LiveVtoTrackingGuidance {
    if (observation.outcome == LiveVtoPerceptionOutcome.POSE_REFUSED) return LiveVtoTrackingGuidance.STEP_BACK
    return when (observation.geometryFailure) {
      LiveVtoGeometryPipeline.Refusal.MISSING_SHOULDERS,
      LiveVtoGeometryPipeline.Refusal.MISSING_HIPS -> LiveVtoTrackingGuidance.STEP_BACK
      LiveVtoGeometryPipeline.Refusal.DEGENERATE_SHOULDER_SPAN -> LiveVtoTrackingGuidance.STEP_CLOSER
      LiveVtoGeometryPipeline.Refusal.DEGENERATE_BODY_AXIS -> LiveVtoTrackingGuidance.CENTER_YOURSELF
      LiveVtoGeometryPipeline.Refusal.NON_FINITE_LANDMARK,
      LiveVtoGeometryPipeline.Refusal.NON_FINITE_GEOMETRY -> LiveVtoTrackingGuidance.HOLD_STILL
      // A garment-side refusal is not something the customer can stand
      // differently to fix, so it produces no framing instruction at all.
      LiveVtoGeometryPipeline.Refusal.MISSING_GARMENT_CONTROL_POINTS,
      LiveVtoGeometryPipeline.Refusal.DEGENERATE_GARMENT_SPAN -> LiveVtoTrackingGuidance.NONE
      else ->
        if (observation.trackingConfidence.isFinite() && observation.trackingConfidence < weakFloorConfidence) {
          // Seen, but barely. The most common recoverable cause on a phone.
          LiveVtoTrackingGuidance.IMPROVE_LIGHTING
        } else {
          LiveVtoTrackingGuidance.HOLD_STILL
        }
    }
  }

  /**
   * Applies the new position and decides whether it is worth an event.
   *
   * A phase CHANGE always emits. A repeat of the same phase emits only when
   * something a surface would actually render changed (guidance, or capture
   * readiness) AND at most once per [reEmitIntervalMs] -- the coalescing
   * that keeps an accessibility live region from announcing every inference.
   */
  private fun commit(
    nextPhase: LiveVtoTrackingPhase,
    nextGuidance: LiveVtoTrackingGuidance,
    personFrameAvailable: Boolean,
    monotonicMs: Long,
  ): LiveVtoTrackingEvent? {
    val previousPhase = phase
    val nextCaptureReady = nextPhase == LiveVtoTrackingPhase.ACQUIRED && personFrameAvailable

    phase = nextPhase
    guidance = nextGuidance
    captureReady = nextCaptureReady

    val name = when (nextPhase) {
      LiveVtoTrackingPhase.ACQUIRING -> null
      LiveVtoTrackingPhase.ACQUIRED ->
        if (previousPhase == LiveVtoTrackingPhase.WEAK || previousPhase == LiveVtoTrackingPhase.LOST) {
          "trackingRecovered"
        } else {
          "trackingAcquired"
        }
      LiveVtoTrackingPhase.WEAK -> "trackingWeak"
      LiveVtoTrackingPhase.LOST -> "trackingLost"
    } ?: return null

    val phaseChanged = nextPhase != previousPhase
    if (!phaseChanged) {
      val readinessChanged = lastEmittedCaptureReady != nextCaptureReady
      val guidanceChanged = lastEmittedGuidance != nextGuidance
      if (!readinessChanged && !guidanceChanged) return null
      // COALESCING APPLIES TO GUIDANCE ONLY, NEVER TO READINESS.
      //
      // Capture readiness is an authority a control is bound to, and a
      // throttle on it is wrong in BOTH directions: delaying a withdrawal
      // leaves an enabled button that would capture nothing, and delaying a
      // grant leaves a disabled button on a session that is ready. Guidance
      // is the noisy signal -- a framing hint that changes every few frames
      // as somebody shifts -- and it is the one an accessibility live region
      // would otherwise announce per inference, so it is the one throttled.
      val since = lastEmitMs
      if (!readinessChanged && since != null && monotonicMs - since < reEmitIntervalMs) return null
    }

    lastEmitMs = monotonicMs
    lastEmittedName = name
    lastEmittedGuidance = nextGuidance
    lastEmittedCaptureReady = nextCaptureReady
    return LiveVtoTrackingEvent(name, payloadFor(name, nextGuidance, nextCaptureReady))
  }

  /**
   * The bridge payload. Shapes match `LiveVtoEventPayloads` in
   * types/vtoLive.ts exactly, plus the ADDITIVE `captureReady` field every
   * tracking event now carries -- that field is what lets the JS reducer
   * recompute the capture authority from the same facts native used, instead
   * of guessing it from a session state.
   */
  private fun payloadFor(
    name: String,
    nextGuidance: LiveVtoTrackingGuidance,
    nextCaptureReady: Boolean,
  ): Map<String, Any?> = when (name) {
    "trackingWeak" -> mapOf(
      "confidence" to confidence.toDouble(),
      "guidance" to nextGuidance.wireToken,
      "captureReady" to nextCaptureReady,
    )
    "trackingLost" -> mapOf("captureReady" to nextCaptureReady)
    else -> mapOf("confidence" to confidence.toDouble(), "captureReady" to nextCaptureReady)
  }

  companion object {
    /**
     * FROZEN FOR THIS LANE, PENDING-RUNTIME CALIBRATION.
     *
     * These are contract thresholds, not tuned device constants: no phone
     * was available to this lane, so nothing here was fitted to measured
     * hardware behaviour, and pretending otherwise would be exactly the
     * fabricated evidence the mission forbids. They are chosen to be
     * conservative -- a session is called ACQUIRED only on sustained,
     * gate-passing, high-confidence geometry -- and Journey C of
     * docs/vto-physical-qa-run-packet.md collects the evidence needed to
     * revisit them.
     */
    const val STRONG_CONFIDENCE = 0.60f
    const val WEAK_FLOOR_CONFIDENCE = 0.30f

    /** Consecutive strong observations before ACQUIRED. At the 33 ms
     *  producer cadence this is roughly 100 ms of sustained good tracking. */
    const val ACQUIRE_STREAK = 3

    /** Consecutive non-strong observations before demoting to WEAK. */
    const val DEMOTE_STREAK = 2

    /** No resolved pose for this long while ACQUIRED -> WEAK. */
    const val WEAK_AFTER_MS = 400L

    /** No resolved pose for this long -> LOST, from any phase. */
    const val LOST_AFTER_MS = 900L

    /** Minimum spacing between two events of the SAME phase. Coalescing, so
     *  an accessibility live region is not driven once per inference. */
    const val RE_EMIT_INTERVAL_MS = 250L
  }
}
