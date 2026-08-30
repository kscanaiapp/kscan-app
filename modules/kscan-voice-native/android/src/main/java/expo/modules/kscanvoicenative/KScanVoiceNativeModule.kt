package expo.modules.kscanvoicenative

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

private const val MAX_DURATION_MS = 15_000L

private class VoicePermissionDeniedException :
  CodedException("PERMISSION_DENIED", "Microphone permission was denied.", null)

private class VoiceOnDeviceUnavailableException :
  CodedException(
    "ON_DEVICE_RECOGNITION_UNAVAILABLE",
    "On-device speech recognition is not available on this device.",
    null
  )

private class VoiceAlreadyListeningException :
  CodedException("ALREADY_LISTENING", "A Voice Scan listening session is already active.", null)

private class VoiceNotListeningException :
  CodedException("NOT_LISTENING", "No Voice Scan listening session is active.", null)

private class VoiceRecognizerError(message: String) :
  CodedException("RECOGNIZER_ERROR", message, null)

/**
 * On-device-only speech-to-text adapter for Voice Scan V1.
 *
 * PRIVACY CONTRACT: this module only ever creates a recognizer via
 * SpeechRecognizer.createOnDeviceSpeechRecognizer(), never
 * createSpeechRecognizer() (which may use a cloud-backed engine).
 * Capability is checked with SpeechRecognizer.isOnDeviceRecognitionAvailable()
 * before every session -- when it is false (including every device below
 * API 31, which does not expose this API at all), startListening rejects
 * with ON_DEVICE_RECOGNITION_UNAVAILABLE instead of falling back to a
 * network-capable recognizer. Do not introduce createSpeechRecognizer() here
 * to "fix" a device that lacks on-device support; the correct behavior for
 * that device is Text Scan.
 *
 * This module knows nothing about Commerce, K+, TextScan, or Edge
 * Functions -- it only listens and hands back a transcript (or an error).
 */
class KScanVoiceNativeModule : Module() {
  private var recognizer: SpeechRecognizer? = null
  private var latestPartialTranscript = ""
  private var sessionLocale: String? = null
  private var activeSessionId: String? = null
  private var pendingStopPromise: Promise? = null
  private val handler = Handler(Looper.getMainLooper())
  private var maxDurationRunnable: Runnable? = null

  private val context: Context
    get() = appContext.reactContext ?: throw VoiceRecognizerError("No Android context available.")

  // App-background release: ProcessLifecycleOwner fires onStop() the moment
  // no activity is in the foreground, independent of any single Activity's
  // own lifecycle -- this is the "app background / interruption" guard.
  private val processLifecycleObserver = object : DefaultLifecycleObserver {
    override fun onStop(owner: LifecycleOwner) {
      teardownSession(emitInterruptedEvent = true)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("KScanVoiceNative")

    Events("onPartialTranscript", "onSessionEnded")

    AsyncFunction("getCapabilities") {
      capabilitiesPayload()
    }

    AsyncFunction("requestPermissions") { promise: Promise ->
      requestPermissions(promise)
    }

    AsyncFunction("startListening") { options: Map<String, Any?>?, promise: Promise ->
      startListening(
        options?.get("locale") as? String,
        options?.get("sessionId") as? String,
        promise
      )
    }

    AsyncFunction("stopListening") { options: Map<String, Any?>, promise: Promise ->
      finishListening(options["sessionId"] as? String, promise)
    }

    AsyncFunction("cancelListening") { options: Map<String, Any?>, promise: Promise ->
      cancelListening(options["sessionId"] as? String, promise)
    }

    OnCreate {
      ProcessLifecycleOwner.get().lifecycle.addObserver(processLifecycleObserver)
    }

    OnDestroy {
      ProcessLifecycleOwner.get().lifecycle.removeObserver(processLifecycleObserver)
      teardownSession(emitInterruptedEvent = false)
    }
  }

  // ── Capabilities ────────────────────────────────────────────────────────

  private fun capabilitiesPayload(): Map<String, Any> {
    val onDeviceAvailable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    } else {
      false
    }
    return mapOf(
      "supported" to SpeechRecognizer.isRecognitionAvailable(context),
      "onDeviceAvailable" to onDeviceAvailable,
      "platform" to "android"
    )
  }

  // ── Permissions ─────────────────────────────────────────────────────────

  private fun requestPermissions(promise: Promise) {
    val permissionsManager = appContext.permissions
    if (permissionsManager == null) {
      promise.resolve(mapOf("granted" to false, "canAskAgain" to false))
      return
    }
    permissionsManager.askForPermissions(
      { response ->
        val entry = response[Manifest.permission.RECORD_AUDIO]
        promise.resolve(
          mapOf(
            "granted" to (entry?.status == PermissionsStatus.GRANTED),
            "canAskAgain" to (entry?.canAskAgain ?: false)
          )
        )
      },
      Manifest.permission.RECORD_AUDIO
    )
  }

  private fun hasRecordAudioPermission(): Boolean {
    return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
  }

  // ── Start ───────────────────────────────────────────────────────────────

  private fun startListening(locale: String?, sessionId: String?, promise: Promise) {
    if (sessionId.isNullOrBlank()) {
      promise.reject(VoiceRecognizerError("Missing Voice Scan session identity."))
      return
    }
    if (recognizer != null) {
      promise.reject(VoiceAlreadyListeningException())
      return
    }
    if (!hasRecordAudioPermission()) {
      promise.reject(VoicePermissionDeniedException())
      return
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
      promise.reject(VoiceOnDeviceUnavailableException())
      return
    }

    val resolvedLocale = locale ?: Locale.getDefault().toLanguageTag()
    latestPartialTranscript = ""
    sessionLocale = resolvedLocale
    activeSessionId = sessionId

    val speechRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
    recognizer = speechRecognizer

    speechRecognizer.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {}
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {}
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onEvent(eventType: Int, params: Bundle?) {}

      override fun onError(error: Int) {
        completeSession(sessionId = sessionId, reason = "error", errorCode = error.toString())
      }

      override fun onPartialResults(partialResults: Bundle?) {
        if (activeSessionId != sessionId) return
        val text = partialResults
          ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
          ?.firstOrNull()
        if (!text.isNullOrEmpty()) {
          latestPartialTranscript = text
          sendEvent("onPartialTranscript", mapOf("sessionId" to sessionId, "transcript" to text))
        }
      }

      override fun onResults(results: Bundle?) {
        if (activeSessionId != sessionId) return
        val text = results
          ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
          ?.firstOrNull()
        if (!text.isNullOrEmpty()) {
          latestPartialTranscript = text
        }
        completeSession(sessionId = sessionId, reason = "recognizer_finalized", errorCode = null)
      }
    })

    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, resolvedLocale)
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
    }

    try {
      speechRecognizer.startListening(intent)
    } catch (t: Throwable) {
      teardownSession(emitInterruptedEvent = false)
      promise.reject(VoiceRecognizerError(t.message ?: "Failed to start listening."))
      return
    }

    val timeoutRunnable = Runnable {
      completeSession(sessionId = sessionId, reason = "max_duration_reached", errorCode = null)
    }
    maxDurationRunnable = timeoutRunnable
    handler.postDelayed(timeoutRunnable, MAX_DURATION_MS)

    promise.resolve(null)
  }

  // ── Stop / cancel ───────────────────────────────────────────────────────

  private fun finishListening(sessionId: String?, promise: Promise) {
    val active = recognizer
    if (active == null || activeSessionId != sessionId) {
      promise.reject(VoiceNotListeningException())
      return
    }
    if (pendingStopPromise != null) {
      promise.reject(VoiceAlreadyListeningException())
      return
    }
    pendingStopPromise = promise
    maxDurationRunnable?.let { handler.removeCallbacks(it) }
    maxDurationRunnable = null
    // stopListening() asks the recognizer to finalize; the RecognitionListener's
    // onResults/onError callback above resolves pendingStopPromise, not here.
    active.stopListening()
  }

  private fun cancelListening(sessionId: String?, promise: Promise) {
    if (recognizer == null || activeSessionId != sessionId) {
      promise.resolve(null)
      return
    }
    // A cancel must never surface a transcript, even a partial one.
    latestPartialTranscript = ""
    val hadPendingStop = pendingStopPromise
    pendingStopPromise = null
    teardownSession(emitInterruptedEvent = false)
    hadPendingStop?.reject(VoiceNotListeningException())
    promise.resolve(null)
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  private fun completeSession(sessionId: String, reason: String, errorCode: String?) {
    if (recognizer == null || activeSessionId != sessionId) return

    val transcript = latestPartialTranscript.trim()
    val locale = sessionLocale
    // This session only ever ran on a recognizer created via
    // createOnDeviceSpeechRecognizer(), so a result reaching this point is
    // on-device by construction.
    val onDevice = true

    val pending = pendingStopPromise
    pendingStopPromise = null
    teardownSession(emitInterruptedEvent = false)

    if (pending != null) {
      if (reason == "error" || transcript.isEmpty()) {
        pending.resolve(null)
      } else {
        pending.resolve(mapOf("transcript" to transcript, "locale" to locale, "onDevice" to onDevice))
      }
      return
    }

    // No JS-initiated stop was pending: the session ended on its own
    // (recognizer finalized speech, the 15s cap fired, or an error) --
    // notify JS via event so its state machine can leave "listening"
    // without polling. When the session finalized WITH usable speech, this
    // event is the only way JS ever learns the result, so it must carry it
    // (mirrors exactly what a pending stopListening() promise would have
    // resolved with).
    val payload = mutableMapOf<String, Any>("sessionId" to sessionId, "reason" to reason)
    if (errorCode != null) {
      payload["errorCode"] = errorCode
    }
    if (reason != "error" && transcript.isNotEmpty()) {
      payload["result"] = mapOf("transcript" to transcript, "locale" to locale, "onDevice" to onDevice)
    }
    sendEvent("onSessionEnded", payload)
  }

  private fun teardownSession(emitInterruptedEvent: Boolean) {
    val wasListening = recognizer != null
    val interruptedSessionId = activeSessionId
    val interruptedStop = pendingStopPromise
    pendingStopPromise = null
    maxDurationRunnable?.let { handler.removeCallbacks(it) }
    maxDurationRunnable = null
    recognizer?.let {
      it.cancel()
      it.destroy()
    }
    recognizer = null
    latestPartialTranscript = ""
    sessionLocale = null
    activeSessionId = null

    interruptedStop?.reject(VoiceNotListeningException())
    if (emitInterruptedEvent && wasListening && interruptedSessionId != null) {
      sendEvent(
        "onSessionEnded",
        mapOf("sessionId" to interruptedSessionId, "reason" to "interrupted")
      )
    }
  }
}
