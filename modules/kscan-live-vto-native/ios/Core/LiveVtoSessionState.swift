/// Part B: the native-internal session lifecycle state machine.
///
/// Field-for-field port of Android's `LiveVtoSessionState.kt` -- see that
/// file's header for why this is a SEPARATE vocabulary from
/// `types/vtoLive.ts`'s `LiveVtoSessionState` (the JS-facing states a UI
/// renders) rather than a duplicate of it: this layer answers "is this
/// native COMMAND valid right now", the JS reducer answers "what does the
/// customer see", and this layer's transitions are what cause
/// `LiveVtoRenderView`'s session methods to emit the events that reducer
/// consumes.
///
/// PURE ON PURPOSE. Zero UIKit/ExpoModulesCore/AVFoundation imports (this
/// file lives in `ios/Core/`, the SAME zero-platform-import SwiftPM target
/// `LiveVtoRuntimeBoundaryTests.testCoreHasNoPlatformDependencies` already
/// enforces), so the entire required test matrix runs via `swift test` with
/// no device, exactly like the geometry conformance stack.
public enum LiveVtoSessionState: Equatable {
  case created
  case garmentLoading
  case ready
  case starting
  case running
  case paused
  case stopping
  case stopped
  case capturing
  case disposed
  case error

  public static let allCases: [LiveVtoSessionState] = [
    .created, .garmentLoading, .ready, .starting, .running, .paused, .stopping, .stopped, .capturing, .disposed, .error,
  ]
}

/// Mirrors Android's `LiveVtoSessionCommand` one-to-one.
public enum LiveVtoSessionCommand: Equatable {
  case start
  case loadGarment
  case switchGarment
  case pause
  case resume
  case stop
  case capture
  case dispose

  public static let allCases: [LiveVtoSessionCommand] = [
    .start, .loadGarment, .switchGarment, .pause, .resume, .stop, .capture, .dispose,
  ]
}

/// Mirrors Android's `LiveVtoSessionCompletion` one-to-one.
public enum LiveVtoSessionCompletion: Equatable {
  case runtimeReady
  case runtimeFailed
  case garmentLoaded
  case garmentLoadFailed
  case stopped
  case captureFinished
  case fatal
}

public struct LiveVtoSessionCommandResult: Equatable {
  public let accepted: Bool
  public let next: LiveVtoSessionState
}

public struct LiveVtoSessionCompletionResult: Equatable {
  public let next: LiveVtoSessionState
}

/// The transition table. A pure function of (current state, input) -> next
/// state -- no fields, no side effects.
public enum LiveVtoSessionMachine {

  /// Which state a command resumes INTO once its async work completes, for
  /// commands that pass through an intermediate state (`capturing`/
  /// `garmentLoading` while switching). See Android's `resumeStateFor` --
  /// recorded at acceptance time, not re-derived later.
  public static func resumeState(for before: LiveVtoSessionState) -> LiveVtoSessionState {
    switch before {
    case .running, .paused: return before
    default: return .running
    }
  }

  /// Applies one command. `accepted == false` always carries back the
  /// UNCHANGED current state.
  public static func apply(_ current: LiveVtoSessionState, _ command: LiveVtoSessionCommand) -> LiveVtoSessionCommandResult {
    let next: LiveVtoSessionState?
    switch command {
    case .start:
      switch current {
      case .created, .stopped, .error: next = .starting
      default: next = nil
      }
    case .loadGarment:
      switch current {
      case .created, .starting, .ready, .stopped: next = .garmentLoading
      default: next = nil
      }
    case .switchGarment:
      switch current {
      case .running, .paused, .ready: next = .garmentLoading
      default: next = nil
      }
    case .pause:
      next = (current == .running) ? .paused : nil
    case .resume:
      next = (current == .paused) ? .running : nil
    case .stop:
      switch current {
      case .created, .stopped: next = current // idempotent no-op
      case .disposed: next = nil // terminal: refused, not a no-op
      default: next = .stopping
      }
    case .capture:
      switch current {
      case .running, .paused: next = .capturing
      default: next = nil
      }
    case .dispose:
      next = .disposed // universal, always idempotent
    }
    guard let resolved = next else {
      return LiveVtoSessionCommandResult(accepted: false, next: current)
    }
    return LiveVtoSessionCommandResult(accepted: true, next: resolved)
  }

  /// Applies a genuine (already generation-checked) completion.
  public static func complete(
    _ current: LiveVtoSessionState,
    _ completion: LiveVtoSessionCompletion,
    resumeTo: LiveVtoSessionState = .running
  ) -> LiveVtoSessionCompletionResult {
    let next: LiveVtoSessionState
    switch completion {
    case .runtimeReady:
      next = (current == .starting) ? .running : current
    case .runtimeFailed:
      next = (current == .starting) ? .error : current
    case .garmentLoaded:
      next = (current == .garmentLoading) ? resumeTo : current
    case .garmentLoadFailed:
      next = (current == .garmentLoading) ? .error : current
    case .stopped:
      next = (current == .stopping) ? .stopped : current
    case .captureFinished:
      next = (current == .capturing) ? resumeTo : current
    case .fatal:
      next = .error
    }
    return LiveVtoSessionCompletionResult(next: next)
  }
}

/// Native mirror of `LiveVtoGarmentDescriptor` in types/vtoLive.ts.
/// Re-declared, not imported -- same reasoning as `LiveVtoGarment.swift`'s
/// re-declaration of the `.ksgarment` contract.
public struct LiveVtoGarmentDescriptor: Equatable {
  public static let supportedTemplateFamilies: Set<String> = ["t-shirt", "simple-top", "sweater"]

  public let productRef: String
  public let imageUrl: String
  public let canonicalCategory: String
  public let templateFamily: String

  public init(productRef: String, imageUrl: String, canonicalCategory: String, templateFamily: String) {
    self.productRef = productRef
    self.imageUrl = imageUrl
    self.canonicalCategory = canonicalCategory
    self.templateFamily = templateFamily
  }

  /// Parses and validates an Expo-bridged `[String: Any]` command argument.
  /// Returns nil for anything malformed -- never throws.
  public static func fromBridgeMap(_ raw: [String: Any]?) -> LiveVtoGarmentDescriptor? {
    guard
      let productRef = raw?["productRef"] as? String, !productRef.isEmpty,
      let imageUrl = raw?["imageUrl"] as? String, !imageUrl.isEmpty,
      let canonicalCategory = raw?["canonicalCategory"] as? String, !canonicalCategory.isEmpty,
      let templateFamily = raw?["templateFamily"] as? String,
      supportedTemplateFamilies.contains(templateFamily)
    else { return nil }
    return LiveVtoGarmentDescriptor(productRef: productRef, imageUrl: imageUrl, canonicalCategory: canonicalCategory, templateFamily: templateFamily)
  }
}
