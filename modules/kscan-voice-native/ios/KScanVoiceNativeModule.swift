import ExpoModulesCore
import Speech
import AVFoundation
import UIKit

// MARK: - Errors

private class VoicePermissionDeniedException: Exception {
  override var reason: String { "Microphone or speech-recognition permission was denied." }
}

private class VoiceOnDeviceUnavailableException: Exception {
  override var reason: String {
    "On-device speech recognition is not available for this locale on this device."
  }
}

private class VoiceAlreadyListeningException: Exception {
  override var reason: String { "A Voice Scan listening session is already active." }
}

private class VoiceNotListeningException: Exception {
  override var reason: String { "No Voice Scan listening session is active." }
}

private class VoiceRecognizerException: GenericException<String> {
  override var reason: String { "Speech recognition failed: \(param)" }
}

/**
 * On-device-only speech-to-text adapter for Voice Scan V1.
 *
 * PRIVACY CONTRACT: every recognition request created here sets
 * `requiresOnDeviceRecognition = true`. That single flag is what keeps this
 * module from ever silently falling back to Apple's network recognizer --
 * if on-device recognition can't be guaranteed for the current locale,
 * `startListening` rejects with ON_DEVICE_RECOGNITION_UNAVAILABLE instead of
 * relaxing the flag. Do not remove it to work around a recognition failure.
 *
 * This module knows nothing about Commerce, K+, TextScan, or Edge
 * Functions -- it only listens and hands back a transcript (or an error).
 */
public class KScanVoiceNativeModule: Module {
  private static let maxDurationSeconds: TimeInterval = 15.0

  private enum SessionEndReason {
    case recognizerFinalized
    case maxDurationReached
    case error
    case interrupted
  }

  private var audioEngine: AVAudioEngine?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var maxDurationTimer: Timer?
  private var latestPartialTranscript = ""
  private var sessionLocale: String?
  private var activeSessionId: String?
  private var pendingStopPromise: Promise?
  private var backgroundObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("KScanVoiceNative")

    Events("onPartialTranscript", "onSessionEnded")

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      self.capabilitiesPayload(locale: nil)
    }

    AsyncFunction("requestPermissions") { (promise: Promise) in
      self.requestPermissions(promise: promise)
    }

    // These three are stateful over shared session fields (activeSessionId,
    // latestPartialTranscript, pendingStopPromise, the engine/recognizer/timer
    // pair). Expo's AsyncFunction does not guarantee a queue by default, so
    // without this they could run concurrently with each other AND with the
    // SFSpeechRecognizer result callback below -- pinning all three to the
    // main queue, alongside that callback hopping to main, gives the session
    // lifecycle one serialized authority instead of racing threads.
    AsyncFunction("startListening") { (options: [String: Any]?, promise: Promise) in
      self.startListening(
        locale: options?["locale"] as? String,
        sessionId: options?["sessionId"] as? String,
        promise: promise
      )
    }
    .runOnQueue(.main)

    AsyncFunction("stopListening") { (options: [String: Any], promise: Promise) in
      self.finishListening(sessionId: options["sessionId"] as? String, promise: promise)
    }
    .runOnQueue(.main)

    AsyncFunction("cancelListening") { (options: [String: Any], promise: Promise) in
      self.cancelListening(sessionId: options["sessionId"] as? String, promise: promise)
    }
    .runOnQueue(.main)

    OnCreate {
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.willResignActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        // App backgrounding / interruption: always release the mic. No
        // background listening exists in this module by construction.
        self?.teardownSession(emitInterruptedEvent: true)
      }
    }

    OnDestroy {
      if let observer = self.backgroundObserver {
        NotificationCenter.default.removeObserver(observer)
      }
      self.teardownSession(emitInterruptedEvent: false)
    }
  }

  // MARK: - Capabilities

  private func capabilitiesPayload(locale: String?) -> [String: Any] {
    let resolvedLocale = locale.map { Locale(identifier: $0) } ?? Locale.current
    let recognizer = SFSpeechRecognizer(locale: resolvedLocale)
    let onDeviceAvailable = (recognizer?.supportsOnDeviceRecognition ?? false) && (recognizer?.isAvailable ?? false)
    return [
      "supported": recognizer != nil,
      "onDeviceAvailable": onDeviceAvailable,
      "platform": "ios",
    ]
  }

  // MARK: - Permissions

  private func requestPermissions(promise: Promise) {
    SFSpeechRecognizer.requestAuthorization { speechStatus in
      DispatchQueue.main.async {
        guard speechStatus == .authorized else {
          promise.resolve(["granted": false, "canAskAgain": speechStatus == .notDetermined])
          return
        }
        self.requestMicrophonePermission { micGranted in
          DispatchQueue.main.async {
            promise.resolve([
              "granted": micGranted,
              // Once this completion has actually run, iOS has either just
              // shown its one-time system prompt and recorded the user's
              // answer, or is returning a previously-recorded answer without
              // showing UI at all -- either way there is no further native
              // prompt this app can ever trigger again for microphone access.
              // A prior version inferred canAskAgain from the pre-request
              // status being .undetermined, which is backwards: undetermined
              // before + denied now means the user just permanently denied
              // it through the one-time prompt, which is exactly the case
              // that must route to Settings, not promise another ask.
              "canAskAgain": false,
            ])
          }
        }
      }
    }
  }

  private func requestMicrophonePermission(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: completion)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(completion)
    }
  }

  // MARK: - Start

  private func startListening(locale: String?, sessionId: String?, promise: Promise) {
    guard let sessionId = sessionId, !sessionId.isEmpty else {
      promise.reject(VoiceRecognizerException("Missing Voice Scan session identity."))
      return
    }
    guard recognitionTask == nil, audioEngine == nil else {
      promise.reject(VoiceAlreadyListeningException())
      return
    }

    guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
      promise.reject(VoicePermissionDeniedException())
      return
    }

    let resolvedLocale = locale.map { Locale(identifier: $0) } ?? Locale.current
    guard
      let recognizer = SFSpeechRecognizer(locale: resolvedLocale),
      recognizer.isAvailable,
      recognizer.supportsOnDeviceRecognition
    else {
      promise.reject(VoiceOnDeviceUnavailableException())
      return
    }

    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      promise.reject(VoiceRecognizerException(error.localizedDescription))
      return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    // See the module-level PRIVACY CONTRACT note above -- this line is load-bearing.
    request.requiresOnDeviceRecognition = true

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let recordingFormat = inputNode.outputFormat(forBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
      request.append(buffer)
    }

    engine.prepare()
    do {
      try engine.start()
    } catch {
      inputNode.removeTap(onBus: 0)
      try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      promise.reject(VoiceRecognizerException(error.localizedDescription))
      return
    }

    audioEngine = engine
    recognitionRequest = request
    sessionLocale = resolvedLocale.identifier
    activeSessionId = sessionId
    latestPartialTranscript = ""

    recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      // SFSpeechRecognizer does not guarantee this handler runs on main, but
      // every field it touches (activeSessionId, latestPartialTranscript,
      // pendingStopPromise via completeSession, teardown state) is also
      // touched by the main-queue-confined AsyncFunctions above. Hop to main
      // before reading or mutating any of it so there is one serialized
      // authority for the session lifecycle, not two threads racing it.
      DispatchQueue.main.async {
        guard let self = self else { return }
        guard self.activeSessionId == sessionId else { return }
        if let result = result {
          self.latestPartialTranscript = result.bestTranscription.formattedString
          self.sendEvent("onPartialTranscript", [
            "sessionId": sessionId,
            "transcript": self.latestPartialTranscript,
          ])
          if result.isFinal {
            self.completeSession(sessionId: sessionId, reason: .recognizerFinalized, error: nil)
          }
        } else if let error = error {
          self.completeSession(sessionId: sessionId, reason: .error, error: error)
        }
      }
    }

    maxDurationTimer = Timer.scheduledTimer(withTimeInterval: Self.maxDurationSeconds, repeats: false) { [weak self] _ in
      self?.completeSession(sessionId: sessionId, reason: .maxDurationReached, error: nil)
    }

    promise.resolve(nil)
  }

  // MARK: - Stop / cancel

  private func finishListening(sessionId: String?, promise: Promise) {
    guard recognitionTask != nil, activeSessionId == sessionId else {
      promise.reject(VoiceNotListeningException())
      return
    }
    guard pendingStopPromise == nil else {
      promise.reject(VoiceAlreadyListeningException())
      return
    }
    pendingStopPromise = promise
    maxDurationTimer?.invalidate()
    maxDurationTimer = nil
    // Ending audio lets the recognizer finalize its last result, which
    // arrives asynchronously through the recognitionTask callback above --
    // completeSession() resolves pendingStopPromise from there, not here.
    recognitionRequest?.endAudio()
    audioEngine?.stop()
    audioEngine?.inputNode.removeTap(onBus: 0)
  }

  private func cancelListening(sessionId: String?, promise: Promise) {
    guard recognitionTask != nil, activeSessionId == sessionId else {
      promise.resolve(nil)
      return
    }
    // A cancel must never surface a transcript, even a partial one.
    latestPartialTranscript = ""
    let hadPendingStop = pendingStopPromise
    pendingStopPromise = nil
    teardownSession(emitInterruptedEvent: false)
    hadPendingStop?.reject(VoiceNotListeningException())
    promise.resolve(nil)
  }

  // MARK: - Session lifecycle

  private func completeSession(sessionId: String, reason: SessionEndReason, error: Error?) {
    guard recognitionTask != nil, activeSessionId == sessionId else { return }

    let transcript = latestPartialTranscript
    let locale = sessionLocale
    // This session only ever ran with requiresOnDeviceRecognition = true,
    // so a result reaching this point (as opposed to the request having
    // been rejected outright) is on-device by construction.
    let onDevice = true

    let pending = pendingStopPromise
    pendingStopPromise = nil
    teardownSession(emitInterruptedEvent: false)

    if let pending = pending {
      let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
      if reason == .error || trimmed.isEmpty {
        pending.resolve(nil)
      } else {
        pending.resolve([
          "transcript": transcript,
          "locale": locale as Any,
          "onDevice": onDevice,
        ])
      }
      return
    }

    // No JS-initiated stop was pending: the session ended on its own (OS
    // finalized speech, the 15s cap fired, or a recognizer error) --
    // notify JS via event so its state machine can leave "listening"
    // without polling. When the session finalized WITH usable speech, this
    // event is the only way JS ever learns the result, so it must carry it
    // (mirrors exactly what a pending stopListening() promise would have
    // resolved with).
    let mappedReason: String
    switch reason {
    case .maxDurationReached: mappedReason = "max_duration_reached"
    case .recognizerFinalized: mappedReason = "recognizer_finalized"
    case .error: mappedReason = "error"
    case .interrupted: mappedReason = "interrupted"
    }
    var payload: [String: Any] = ["sessionId": sessionId, "reason": mappedReason]
    if let error = error {
      payload["errorCode"] = (error as NSError).domain
    }
    let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    if reason != .error && reason != .interrupted && !trimmed.isEmpty {
      payload["result"] = [
        "transcript": transcript,
        "locale": locale as Any,
        "onDevice": onDevice,
      ]
    }
    sendEvent("onSessionEnded", payload)
  }

  private func teardownSession(emitInterruptedEvent: Bool) {
    let wasListening = recognitionTask != nil
    let interruptedSessionId = activeSessionId
    let interruptedStop = pendingStopPromise
    pendingStopPromise = nil
    maxDurationTimer?.invalidate()
    maxDurationTimer = nil
    recognitionTask?.cancel()
    recognitionTask = nil
    audioEngine?.stop()
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine = nil
    recognitionRequest = nil
    latestPartialTranscript = ""
    sessionLocale = nil
    activeSessionId = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

    interruptedStop?.reject(VoiceNotListeningException())
    if emitInterruptedEvent && wasListening, let sessionId = interruptedSessionId {
      sendEvent("onSessionEnded", ["sessionId": sessionId, "reason": "interrupted"])
    }
  }
}
