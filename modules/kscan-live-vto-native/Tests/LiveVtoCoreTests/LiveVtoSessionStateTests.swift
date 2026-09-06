import XCTest
@testable import LiveVtoCore

/// Part B required test matrix, session-lifecycle half. Field-for-field port
/// of Android's `LiveVtoSessionStateTest.kt` -- see that file for the
/// rationale behind each case; this only needs to prove the SAME table
/// produces the SAME answers on this platform.
final class LiveVtoSessionStateTests: XCTestCase {

  private let allowedFrom: [LiveVtoSessionState: Set<LiveVtoSessionCommand>] = [
    .created: [.start, .loadGarment, .stop, .dispose],
    .garmentLoading: [.stop, .dispose],
    .ready: [.loadGarment, .switchGarment, .stop, .dispose],
    .starting: [.loadGarment, .stop, .dispose],
    .running: [.switchGarment, .pause, .stop, .capture, .dispose],
    .paused: [.switchGarment, .resume, .stop, .capture, .dispose],
    .stopping: [.stop, .dispose],
    .stopped: [.start, .loadGarment, .stop, .dispose],
    .capturing: [.stop, .dispose],
    .disposed: [.dispose],
    .error: [.start, .stop, .dispose],
  ]

  func testEveryStateXCommandPairMatchesTheDeclaredAllowlistExactly() {
    for state in LiveVtoSessionState.allCases {
      let allowed = allowedFrom[state] ?? []
      for command in LiveVtoSessionCommand.allCases {
        let result = LiveVtoSessionMachine.apply(state, command)
        let shouldAccept = allowed.contains(command)
        XCTAssertEqual(result.accepted, shouldAccept, "state=\(state) command=\(command)")
        if !shouldAccept {
          XCTAssertEqual(result.next, state, "a rejected command must never change the state")
        }
      }
    }
  }

  func testNoStartAfterDispose() {
    XCTAssertFalse(LiveVtoSessionMachine.apply(.disposed, .start).accepted)
  }

  func testNoDuplicateStart() {
    let started = LiveVtoSessionMachine.apply(.created, .start)
    XCTAssertTrue(started.accepted)
    XCTAssertFalse(LiveVtoSessionMachine.apply(started.next, .start).accepted)
    let running = LiveVtoSessionMachine.complete(started.next, .runtimeReady).next
    XCTAssertFalse(LiveVtoSessionMachine.apply(running, .start).accepted)
  }

  func testPauseOnlyFromRunning() {
    for state in LiveVtoSessionState.allCases {
      XCTAssertEqual(LiveVtoSessionMachine.apply(state, .pause).accepted, state == .running, "PAUSE from \(state)")
    }
  }

  func testResumeOnlyFromPaused() {
    for state in LiveVtoSessionState.allCases {
      XCTAssertEqual(LiveVtoSessionMachine.apply(state, .resume).accepted, state == .paused, "RESUME from \(state)")
    }
  }

  func testStopAndDisposeAreIdempotent() {
    let stopAgain = LiveVtoSessionMachine.apply(.stopped, .stop)
    XCTAssertTrue(stopAgain.accepted)
    XCTAssertEqual(stopAgain.next, .stopped)

    for state in LiveVtoSessionState.allCases {
      let result = LiveVtoSessionMachine.apply(state, .dispose)
      XCTAssertTrue(result.accepted, "DISPOSE from \(state) must be accepted")
      XCTAssertEqual(result.next, .disposed)
    }

    XCTAssertFalse(LiveVtoSessionMachine.apply(.disposed, .stop).accepted)
  }

  func testCaptureCannotOutliveADisposedSession() {
    for state in LiveVtoSessionState.allCases {
      let shouldAccept = state == .running || state == .paused
      XCTAssertEqual(LiveVtoSessionMachine.apply(state, .capture).accepted, shouldAccept, "CAPTURE from \(state)")
    }
    XCTAssertFalse(LiveVtoSessionMachine.apply(.disposed, .capture).accepted)
  }

  func testCaptureIsSingleFlight() {
    let first = LiveVtoSessionMachine.apply(.running, .capture)
    XCTAssertTrue(first.accepted)
    XCTAssertEqual(first.next, .capturing)
    XCTAssertFalse(LiveVtoSessionMachine.apply(first.next, .capture).accepted)
  }

  func testCaptureResumesToTheStateItInterrupted() {
    let fromRunning = LiveVtoSessionMachine.apply(.running, .capture).next
    XCTAssertEqual(LiveVtoSessionMachine.complete(fromRunning, .captureFinished, resumeTo: .running).next, .running)
    let fromPaused = LiveVtoSessionMachine.apply(.paused, .capture).next
    XCTAssertEqual(LiveVtoSessionMachine.complete(fromPaused, .captureFinished, resumeTo: .paused).next, .paused)
  }

  func testFailedGarmentLoadCannotLeaveSessionPretendingReady() {
    let loading = LiveVtoSessionMachine.apply(.created, .loadGarment)
    XCTAssertTrue(loading.accepted)
    let failed = LiveVtoSessionMachine.complete(loading.next, .garmentLoadFailed)
    XCTAssertEqual(failed.next, .error)
    XCTAssertFalse(LiveVtoSessionMachine.apply(failed.next, .capture).accepted)
    XCTAssertFalse(LiveVtoSessionMachine.apply(failed.next, .loadGarment).accepted)
  }

  func testSwitchGarmentCannotAttachToAStaleSession() {
    for state: LiveVtoSessionState in [.created, .starting, .garmentLoading, .stopping, .stopped, .capturing, .disposed, .error] {
      XCTAssertFalse(LiveVtoSessionMachine.apply(state, .switchGarment).accepted, "SWITCH_GARMENT from \(state) must be refused")
    }
  }

  func testStopWhileStartingIsAcceptedAndTerminates() {
    let starting = LiveVtoSessionMachine.apply(.created, .start)
    XCTAssertTrue(starting.accepted)
    let stopping = LiveVtoSessionMachine.apply(starting.next, .stop)
    XCTAssertTrue(stopping.accepted)
    XCTAssertEqual(stopping.next, .stopping)
    XCTAssertEqual(LiveVtoSessionMachine.complete(stopping.next, .runtimeReady).next, .stopping)
    XCTAssertEqual(LiveVtoSessionMachine.complete(stopping.next, .stopped).next, .stopped)
  }

  func testDisposeWhileStartingTerminatesRegardlessOfLateCompletion() {
    let starting = LiveVtoSessionMachine.apply(.created, .start).next
    let disposed = LiveVtoSessionMachine.apply(starting, .dispose)
    XCTAssertTrue(disposed.accepted)
    XCTAssertEqual(disposed.next, .disposed)
    XCTAssertEqual(LiveVtoSessionMachine.complete(disposed.next, .runtimeReady).next, .disposed)
  }

  func testGarmentSwitchDuringStartIsRefusedNotQueued() {
    let starting = LiveVtoSessionMachine.apply(.created, .start).next
    XCTAssertFalse(LiveVtoSessionMachine.apply(starting, .switchGarment).accepted)
  }

  func testStopDuringGarmentLoadIsAccepted() {
    let loading = LiveVtoSessionMachine.apply(.ready, .loadGarment).next
    let stopping = LiveVtoSessionMachine.apply(loading, .stop)
    XCTAssertTrue(stopping.accepted)
    XCTAssertEqual(stopping.next, .stopping)
    XCTAssertEqual(LiveVtoSessionMachine.complete(stopping.next, .garmentLoaded).next, .stopping)
  }

  func testDisposeDuringCaptureInvalidatesTheCapture() {
    let capturing = LiveVtoSessionMachine.apply(.running, .capture).next
    let disposed = LiveVtoSessionMachine.apply(capturing, .dispose)
    XCTAssertTrue(disposed.accepted)
    XCTAssertEqual(disposed.next, .disposed)
    XCTAssertEqual(LiveVtoSessionMachine.complete(disposed.next, .captureFinished).next, .disposed)
  }

  func testRapidGarmentSwitchAThenBThenCLandsOnC() {
    var state = LiveVtoSessionMachine.apply(.running, .switchGarment).next
    XCTAssertEqual(state, .garmentLoading)
    XCTAssertFalse(LiveVtoSessionMachine.apply(state, .switchGarment).accepted)
    state = LiveVtoSessionMachine.complete(state, .garmentLoaded, resumeTo: .running).next
    XCTAssertEqual(state, .running)
    state = LiveVtoSessionMachine.apply(state, .switchGarment).next
    state = LiveVtoSessionMachine.complete(state, .garmentLoaded, resumeTo: .running).next
    XCTAssertEqual(state, .running)
  }
}
