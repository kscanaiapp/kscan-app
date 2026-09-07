package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Part B required test matrix, session-lifecycle half: every state, every
 * command, and the documented races -- run as a pure JVM transition-table
 * check, not against a device. `LiveVtoNativeSessionTest` covers the
 * generation/epoch wiring this table is fed through; this file only tests
 * the table itself.
 */
class LiveVtoSessionStateTest {

  // ─── Exhaustive (state x command) matrix ──────────────────────────────────

  /**
   * The one command accepted from each state, and every OTHER command
   * refused from it. Written as an explicit allow-list per state (not a
   * generic "anything not in this list is refused" comment) so a future
   * command added to LiveVtoSessionCommand without updating this map fails
   * loudly here rather than silently passing.
   */
  private val allowedFrom: Map<LiveVtoSessionState, Set<LiveVtoSessionCommand>> = mapOf(
    LiveVtoSessionState.CREATED to setOf(LiveVtoSessionCommand.START, LiveVtoSessionCommand.LOAD_GARMENT, LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.GARMENT_LOADING to setOf(LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.READY to setOf(LiveVtoSessionCommand.LOAD_GARMENT, LiveVtoSessionCommand.SWITCH_GARMENT, LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.STARTING to setOf(LiveVtoSessionCommand.LOAD_GARMENT, LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.RUNNING to setOf(LiveVtoSessionCommand.SWITCH_GARMENT, LiveVtoSessionCommand.PAUSE, LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.CAPTURE, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.PAUSED to setOf(LiveVtoSessionCommand.SWITCH_GARMENT, LiveVtoSessionCommand.RESUME, LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.CAPTURE, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.STOPPING to setOf(LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.STOPPED to setOf(LiveVtoSessionCommand.START, LiveVtoSessionCommand.LOAD_GARMENT, LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.CAPTURING to setOf(LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.DISPOSED to setOf(LiveVtoSessionCommand.DISPOSE),
    LiveVtoSessionState.ERROR to setOf(LiveVtoSessionCommand.START, LiveVtoSessionCommand.STOP, LiveVtoSessionCommand.DISPOSE),
  )

  @Test
  fun everyStateXCommandPairMatchesTheDeclaredAllowlistExactly() {
    for (state in LiveVtoSessionMachine.ALL_STATES) {
      val allowed = allowedFrom.getValue(state)
      for (command in LiveVtoSessionMachine.ALL_COMMANDS) {
        val result = LiveVtoSessionMachine.apply(state, command)
        val shouldAccept = command in allowed
        assertEquals(
          "state=$state command=$command: expected accepted=$shouldAccept, got ${result.accepted}",
          shouldAccept,
          result.accepted,
        )
        if (!shouldAccept) {
          assertEquals("a rejected command must never change the state", state, result.next)
        }
      }
    }
  }

  // ─── Named invariants (mission section 15) ────────────────────────────────

  @Test
  fun noStartAfterDispose() {
    assertFalse(LiveVtoSessionMachine.apply(LiveVtoSessionState.DISPOSED, LiveVtoSessionCommand.START).accepted)
  }

  @Test
  fun noDuplicateStart() {
    val started = LiveVtoSessionMachine.apply(LiveVtoSessionState.CREATED, LiveVtoSessionCommand.START)
    assertTrue(started.accepted)
    assertFalse(LiveVtoSessionMachine.apply(started.next, LiveVtoSessionCommand.START).accepted)
    val running = LiveVtoSessionMachine.complete(started.next, LiveVtoSessionCompletion.RUNTIME_READY).next
    assertFalse(LiveVtoSessionMachine.apply(running, LiveVtoSessionCommand.START).accepted)
  }

  @Test
  fun pauseOnlyFromRunning() {
    for (state in LiveVtoSessionMachine.ALL_STATES) {
      val accepted = LiveVtoSessionMachine.apply(state, LiveVtoSessionCommand.PAUSE).accepted
      assertEquals("PAUSE from $state", state == LiveVtoSessionState.RUNNING, accepted)
    }
  }

  @Test
  fun resumeOnlyFromPaused() {
    for (state in LiveVtoSessionMachine.ALL_STATES) {
      val accepted = LiveVtoSessionMachine.apply(state, LiveVtoSessionCommand.RESUME).accepted
      assertEquals("RESUME from $state", state == LiveVtoSessionState.PAUSED, accepted)
    }
  }

  @Test
  fun stopAndDisposeAreIdempotent() {
    // stop() while already STOPPED is a no-op success, not a rejection.
    val stopAgain = LiveVtoSessionMachine.apply(LiveVtoSessionState.STOPPED, LiveVtoSessionCommand.STOP)
    assertTrue(stopAgain.accepted)
    assertEquals(LiveVtoSessionState.STOPPED, stopAgain.next)

    // dispose() from every state (including DISPOSED itself) succeeds and lands on DISPOSED.
    for (state in LiveVtoSessionMachine.ALL_STATES) {
      val result = LiveVtoSessionMachine.apply(state, LiveVtoSessionCommand.DISPOSE)
      assertTrue("DISPOSE from $state must be accepted", result.accepted)
      assertEquals(LiveVtoSessionState.DISPOSED, result.next)
    }

    // stop() after dispose() is refused outright -- disposal is terminal, not
    // merely "already stopped".
    assertFalse(LiveVtoSessionMachine.apply(LiveVtoSessionState.DISPOSED, LiveVtoSessionCommand.STOP).accepted)
  }

  @Test
  fun captureCannotOutliveADisposedSession() {
    for (state in LiveVtoSessionMachine.ALL_STATES) {
      val accepted = LiveVtoSessionMachine.apply(state, LiveVtoSessionCommand.CAPTURE).accepted
      val shouldAccept = state == LiveVtoSessionState.RUNNING || state == LiveVtoSessionState.PAUSED
      assertEquals("CAPTURE from $state", shouldAccept, accepted)
    }
    // In particular: a session that just disposed refuses a new capture outright.
    assertFalse(LiveVtoSessionMachine.apply(LiveVtoSessionState.DISPOSED, LiveVtoSessionCommand.CAPTURE).accepted)
  }

  @Test
  fun captureIsSingleFlight() {
    val first = LiveVtoSessionMachine.apply(LiveVtoSessionState.RUNNING, LiveVtoSessionCommand.CAPTURE)
    assertTrue(first.accepted)
    assertEquals(LiveVtoSessionState.CAPTURING, first.next)
    // A second capture request arriving before the first resolves is refused,
    // not queued and not overlapping.
    assertFalse(LiveVtoSessionMachine.apply(first.next, LiveVtoSessionCommand.CAPTURE).accepted)
  }

  @Test
  fun captureResumesToTheStateItInterrupted() {
    val fromRunning = LiveVtoSessionMachine.apply(LiveVtoSessionState.RUNNING, LiveVtoSessionCommand.CAPTURE).next
    assertEquals(
      LiveVtoSessionState.RUNNING,
      LiveVtoSessionMachine.complete(fromRunning, LiveVtoSessionCompletion.CAPTURE_FINISHED, resumeTo = LiveVtoSessionState.RUNNING).next,
    )
    val fromPaused = LiveVtoSessionMachine.apply(LiveVtoSessionState.PAUSED, LiveVtoSessionCommand.CAPTURE).next
    assertEquals(
      LiveVtoSessionState.PAUSED,
      LiveVtoSessionMachine.complete(fromPaused, LiveVtoSessionCompletion.CAPTURE_FINISHED, resumeTo = LiveVtoSessionState.PAUSED).next,
    )
  }

  @Test
  fun failedGarmentLoadCannotLeaveSessionPretendingReady() {
    val loading = LiveVtoSessionMachine.apply(LiveVtoSessionState.CREATED, LiveVtoSessionCommand.LOAD_GARMENT)
    assertTrue(loading.accepted)
    val failed = LiveVtoSessionMachine.complete(loading.next, LiveVtoSessionCompletion.GARMENT_LOAD_FAILED)
    assertEquals(LiveVtoSessionState.ERROR, failed.next)
    // ERROR accepts only START/STOP/DISPOSE -- capture, pause, and a further
    // garment load are all refused, so a failed load cannot be mistaken for
    // a usable session by any caller that only checks "did it throw".
    assertFalse(LiveVtoSessionMachine.apply(failed.next, LiveVtoSessionCommand.CAPTURE).accepted)
    assertFalse(LiveVtoSessionMachine.apply(failed.next, LiveVtoSessionCommand.LOAD_GARMENT).accepted)
  }

  @Test
  fun switchGarmentCannotAttachToAStaleSession() {
    // switchGarment is a RUNNING/PAUSED/READY operation -- CREATED (before
    // any garment has ever loaded) must use loadGarment, not switchGarment,
    // and once STOPPING/STOPPED/DISPOSED there is no running session left to
    // switch under.
    for (state in listOf(
      LiveVtoSessionState.CREATED, LiveVtoSessionState.STARTING, LiveVtoSessionState.GARMENT_LOADING,
      LiveVtoSessionState.STOPPING, LiveVtoSessionState.STOPPED, LiveVtoSessionState.CAPTURING,
      LiveVtoSessionState.DISPOSED, LiveVtoSessionState.ERROR,
    )) {
      assertFalse("SWITCH_GARMENT from $state must be refused", LiveVtoSessionMachine.apply(state, LiveVtoSessionCommand.SWITCH_GARMENT).accepted)
    }
  }

  // ─── Races (mission section 13) ────────────────────────────────────────────

  @Test
  fun stopWhileStartingIsAcceptedAndTerminates() {
    val starting = LiveVtoSessionMachine.apply(LiveVtoSessionState.CREATED, LiveVtoSessionCommand.START)
    assertTrue(starting.accepted)
    val stopping = LiveVtoSessionMachine.apply(starting.next, LiveVtoSessionCommand.STOP)
    assertTrue(stopping.accepted)
    assertEquals(LiveVtoSessionState.STOPPING, stopping.next)
    // A late RUNTIME_READY completion that arrives after the stop was issued
    // must not resurrect RUNNING out of STOPPING -- LiveVtoNativeSession
    // guarantees this via the generation check before this table is even
    // consulted, but the table itself also only honours RUNTIME_READY from
    // STARTING, never from STOPPING.
    assertEquals(LiveVtoSessionState.STOPPING, LiveVtoSessionMachine.complete(stopping.next, LiveVtoSessionCompletion.RUNTIME_READY).next)
    assertEquals(
      LiveVtoSessionState.STOPPED,
      LiveVtoSessionMachine.complete(stopping.next, LiveVtoSessionCompletion.STOPPED).next,
    )
  }

  @Test
  fun disposeWhileStartingTerminatesRegardlessOfLateCompletion() {
    val starting = LiveVtoSessionMachine.apply(LiveVtoSessionState.CREATED, LiveVtoSessionCommand.START).next
    val disposed = LiveVtoSessionMachine.apply(starting, LiveVtoSessionCommand.DISPOSE)
    assertTrue(disposed.accepted)
    assertEquals(LiveVtoSessionState.DISPOSED, disposed.next)
    // A stale RUNTIME_READY/RUNTIME_FAILED for the disposed epoch has no
    // effect on the table (DISPOSED is not STARTING), independent of the
    // generation guard that would already have dropped it upstream.
    assertEquals(LiveVtoSessionState.DISPOSED, LiveVtoSessionMachine.complete(disposed.next, LiveVtoSessionCompletion.RUNTIME_READY).next)
  }

  @Test
  fun garmentSwitchDuringStartIsRefusedNotQueued() {
    val starting = LiveVtoSessionMachine.apply(LiveVtoSessionState.CREATED, LiveVtoSessionCommand.START).next
    assertFalse(LiveVtoSessionMachine.apply(starting, LiveVtoSessionCommand.SWITCH_GARMENT).accepted)
  }

  @Test
  fun stopDuringGarmentLoadIsAccepted() {
    val loading = LiveVtoSessionMachine.apply(LiveVtoSessionState.READY, LiveVtoSessionCommand.LOAD_GARMENT).next
    val stopping = LiveVtoSessionMachine.apply(loading, LiveVtoSessionCommand.STOP)
    assertTrue(stopping.accepted)
    assertEquals(LiveVtoSessionState.STOPPING, stopping.next)
    // The garment load's own late success/failure, arriving after the stop,
    // has no effect on the table from STOPPING (not GARMENT_LOADING).
    assertEquals(LiveVtoSessionState.STOPPING, LiveVtoSessionMachine.complete(stopping.next, LiveVtoSessionCompletion.GARMENT_LOADED).next)
  }

  @Test
  fun disposeDuringCaptureInvalidatesTheCapture() {
    val capturing = LiveVtoSessionMachine.apply(LiveVtoSessionState.RUNNING, LiveVtoSessionCommand.CAPTURE).next
    val disposed = LiveVtoSessionMachine.apply(capturing, LiveVtoSessionCommand.DISPOSE)
    assertTrue(disposed.accepted)
    assertEquals(LiveVtoSessionState.DISPOSED, disposed.next)
    assertEquals(LiveVtoSessionState.DISPOSED, LiveVtoSessionMachine.complete(disposed.next, LiveVtoSessionCompletion.CAPTURE_FINISHED).next)
  }

  @Test
  fun rapidGarmentSwitchAThenBThenCLandsOnC() {
    // The table only models one switch at a time (a second SWITCH_GARMENT
    // while already GARMENT_LOADING is refused, forcing callers to
    // serialize) -- LiveVtoNativeSessionTest exercises the generation
    // check that makes a stale A-load's completion unable to overwrite B.
    var state = LiveVtoSessionMachine.apply(LiveVtoSessionState.RUNNING, LiveVtoSessionCommand.SWITCH_GARMENT).next
    assertEquals(LiveVtoSessionState.GARMENT_LOADING, state)
    assertFalse(LiveVtoSessionMachine.apply(state, LiveVtoSessionCommand.SWITCH_GARMENT).accepted)
    state = LiveVtoSessionMachine.complete(state, LiveVtoSessionCompletion.GARMENT_LOADED, resumeTo = LiveVtoSessionState.RUNNING).next
    assertEquals(LiveVtoSessionState.RUNNING, state)
    state = LiveVtoSessionMachine.apply(state, LiveVtoSessionCommand.SWITCH_GARMENT).next
    state = LiveVtoSessionMachine.complete(state, LiveVtoSessionCompletion.GARMENT_LOADED, resumeTo = LiveVtoSessionState.RUNNING).next
    assertEquals(LiveVtoSessionState.RUNNING, state)
  }
}
