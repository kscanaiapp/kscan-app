package expo.modules.kscanlivevtonative

/**
 * Part B: the native-internal session lifecycle state machine.
 *
 * WHY THIS EXISTS SEPARATELY FROM `types/vtoLive.ts`'s `LiveVtoSessionState`.
 * The JS contract's session states (`INITIALIZING`/`READY`/`TRACKING`/...) are
 * what a UI renders, and `services/vto/vtoLiveSession.ts`'s reducer already
 * owns that vocabulary exhaustively -- this file does not duplicate it. What
 * was missing on the native side was the layer BELOW that: a state machine
 * enforcing which native COMMANDS (`start`/`pause`/`resume`/`stop`/
 * `loadGarment`/`switchGarment`/capture/`dispose`) may be accepted from which
 * native lifecycle position, independent of whatever the camera/perception
 * pipeline underneath is doing frame-to-frame. Two different questions:
 * "is a pause valid right now" (this file) vs. "is the customer currently
 * tracked" (the JS reducer, fed by the events this state machine's
 * transitions cause `LiveVtoNativeSession` to emit).
 *
 * PURE ON PURPOSE. Zero Android/Expo imports (enforced by
 * RuntimeBoundaryTest.theGeometryAndReplayStackHasNoAndroidDependencies,
 * which does not need an exception entry for this file), so the entire
 * required test matrix -- every valid transition, every invalid one, every
 * race ordering -- runs on the JVM with no device, exactly like the geometry
 * conformance stack. `LiveVtoNativeSession` is the thin, Android-dependent
 * driver that calls into this table and does not re-implement it.
 */
enum class LiveVtoSessionState {
  CREATED,
  GARMENT_LOADING,
  READY,
  STARTING,
  RUNNING,
  PAUSED,
  STOPPING,
  STOPPED,
  CAPTURING,
  DISPOSED,
  ERROR,
}

/**
 * One command the module-level bridge may ask the state machine to accept.
 * Deliberately mirrors `LIVE_VTO_COMMANDS` in types/vtoLive.ts one-to-one for
 * the commands that have lifecycle meaning; `capturePersonFrame` and
 * `capturePreview` share one `CAPTURE` command here because they differ only
 * in which bitmap source `LiveVtoNativeSession` reads, never in what the
 * state machine allows.
 */
enum class LiveVtoSessionCommand {
  START,
  LOAD_GARMENT,
  SWITCH_GARMENT,
  PAUSE,
  RESUME,
  STOP,
  CAPTURE,
  DISPOSE,
}

/**
 * An async completion arriving back into the machine. Kept distinct from
 * `LiveVtoSessionCommand` because a completion is never rejected the way a
 * command can be -- by the time one of these arrives, the generation check in
 * `LiveVtoNativeSession` has already decided whether it is stale. This table
 * only says what state a GENUINE (non-stale) completion moves to.
 */
enum class LiveVtoSessionCompletion {
  RUNTIME_READY,
  RUNTIME_FAILED,
  GARMENT_LOADED,
  GARMENT_LOAD_FAILED,
  STOPPED,
  CAPTURE_FINISHED,
  FATAL,
}

data class LiveVtoSessionCommandResult(val accepted: Boolean, val next: LiveVtoSessionState)
data class LiveVtoSessionCompletionResult(val next: LiveVtoSessionState)

/**
 * The transition table itself. A pure function of (current state, input) ->
 * next state -- no fields, no side effects, so a test can enumerate every
 * (state, command) pair exhaustively without constructing anything.
 */
object LiveVtoSessionMachine {

  /**
   * Which state a command resumes INTO once its async work completes, for
   * commands that pass through an intermediate state
   * (`CAPTURING`/`GARMENT_LOADING` while switching). Recorded at the moment
   * the command is accepted, not re-derived later, so a capture that started
   * while RUNNING resumes to RUNNING even if something else were racing --
   * ambiguity a "resume to whatever makes sense now" rule would have.
   */
  fun resumeStateFor(before: LiveVtoSessionState): LiveVtoSessionState = when (before) {
    LiveVtoSessionState.RUNNING, LiveVtoSessionState.PAUSED -> before
    else -> LiveVtoSessionState.RUNNING
  }

  /**
   * Applies one command. Returns `accepted = false` (and the UNCHANGED
   * current state) for every invalid transition -- an invariant test asserts
   * the state genuinely does not move, not merely that a boolean came back
   * false.
   */
  fun apply(current: LiveVtoSessionState, command: LiveVtoSessionCommand): LiveVtoSessionCommandResult {
    val next = when (command) {
      LiveVtoSessionCommand.START -> when (current) {
        LiveVtoSessionState.CREATED, LiveVtoSessionState.STOPPED, LiveVtoSessionState.ERROR -> LiveVtoSessionState.STARTING
        else -> null
      }
      LiveVtoSessionCommand.LOAD_GARMENT -> when (current) {
        LiveVtoSessionState.CREATED, LiveVtoSessionState.STARTING,
        LiveVtoSessionState.READY, LiveVtoSessionState.STOPPED -> LiveVtoSessionState.GARMENT_LOADING
        else -> null
      }
      LiveVtoSessionCommand.SWITCH_GARMENT -> when (current) {
        LiveVtoSessionState.RUNNING, LiveVtoSessionState.PAUSED, LiveVtoSessionState.READY -> LiveVtoSessionState.GARMENT_LOADING
        else -> null
      }
      LiveVtoSessionCommand.PAUSE -> when (current) {
        LiveVtoSessionState.RUNNING -> LiveVtoSessionState.PAUSED
        else -> null
      }
      LiveVtoSessionCommand.RESUME -> when (current) {
        LiveVtoSessionState.PAUSED -> LiveVtoSessionState.RUNNING
        else -> null
      }
      LiveVtoSessionCommand.STOP -> when (current) {
        LiveVtoSessionState.CREATED, LiveVtoSessionState.STOPPED -> current // idempotent no-op
        LiveVtoSessionState.DISPOSED -> null // terminal: stop after dispose is refused, not a no-op
        else -> LiveVtoSessionState.STOPPING
      }
      LiveVtoSessionCommand.CAPTURE -> when (current) {
        LiveVtoSessionState.RUNNING, LiveVtoSessionState.PAUSED -> LiveVtoSessionState.CAPTURING
        else -> null
      }
      LiveVtoSessionCommand.DISPOSE -> LiveVtoSessionState.DISPOSED // universal, always idempotent
    }
    return if (next == null) {
      LiveVtoSessionCommandResult(accepted = false, next = current)
    } else {
      LiveVtoSessionCommandResult(accepted = true, next = next)
    }
  }

  /**
   * Applies a genuine (already generation-checked) completion. Every branch
   * is total: an unexpected completion for the current state (e.g. a stray
   * GARMENT_LOADED while CREATED, which should never happen if callers only
   * report completions for work the machine actually accepted) leaves the
   * state unchanged rather than guessing.
   */
  fun complete(
    current: LiveVtoSessionState,
    completion: LiveVtoSessionCompletion,
    resumeTo: LiveVtoSessionState = LiveVtoSessionState.RUNNING,
  ): LiveVtoSessionCompletionResult {
    val next = when (completion) {
      LiveVtoSessionCompletion.RUNTIME_READY ->
        if (current == LiveVtoSessionState.STARTING) LiveVtoSessionState.RUNNING else current
      LiveVtoSessionCompletion.RUNTIME_FAILED ->
        if (current == LiveVtoSessionState.STARTING) LiveVtoSessionState.ERROR else current
      LiveVtoSessionCompletion.GARMENT_LOADED ->
        if (current == LiveVtoSessionState.GARMENT_LOADING) resumeTo else current
      LiveVtoSessionCompletion.GARMENT_LOAD_FAILED ->
        if (current == LiveVtoSessionState.GARMENT_LOADING) LiveVtoSessionState.ERROR else current
      LiveVtoSessionCompletion.STOPPED ->
        if (current == LiveVtoSessionState.STOPPING) LiveVtoSessionState.STOPPED else current
      LiveVtoSessionCompletion.CAPTURE_FINISHED ->
        if (current == LiveVtoSessionState.CAPTURING) resumeTo else current
      LiveVtoSessionCompletion.FATAL -> LiveVtoSessionState.ERROR
    }
    return LiveVtoSessionCompletionResult(next = next)
  }

  /** Every state a fresh session may legitimately visit -- used by tests to
   *  assert the (state x command) matrix above is exhaustive, not sampled. */
  val ALL_STATES: List<LiveVtoSessionState> = LiveVtoSessionState.entries
  val ALL_COMMANDS: List<LiveVtoSessionCommand> = LiveVtoSessionCommand.entries
}

/**
 * Native mirror of `LiveVtoGarmentDescriptor` in types/vtoLive.ts. Re-declared
 * (not imported -- there is nothing to import across the JS/native boundary),
 * same reasoning as `LiveVtoGarment.kt`'s re-declaration of the `.ksgarment`
 * contract: the SAME four fields, the SAME three supported template
 * families, checked here so a malformed descriptor is refused before any
 * asset work starts, not discovered partway through it.
 */
data class LiveVtoGarmentDescriptor(
  val productRef: String,
  val imageUrl: String,
  val canonicalCategory: String,
  val templateFamily: String,
) {
  companion object {
    val SUPPORTED_TEMPLATE_FAMILIES = setOf("t-shirt", "simple-top", "sweater")

    /** Parses and validates an Expo-bridged `Map<String, Any?>` command
     *  argument. Returns null for anything malformed -- never throws, so a
     *  caller can turn that into whichever failure event/exception its own
     *  contract requires. */
    fun fromBridgeMap(raw: Map<String, Any?>?): LiveVtoGarmentDescriptor? {
      val productRef = raw?.get("productRef") as? String
      val imageUrl = raw?.get("imageUrl") as? String
      val canonicalCategory = raw?.get("canonicalCategory") as? String
      val templateFamily = raw?.get("templateFamily") as? String
      if (productRef.isNullOrBlank() || imageUrl.isNullOrBlank() || canonicalCategory.isNullOrBlank()) return null
      if (templateFamily !in SUPPORTED_TEMPLATE_FAMILIES) return null
      return LiveVtoGarmentDescriptor(productRef, imageUrl, canonicalCategory, templateFamily!!)
    }
  }
}
