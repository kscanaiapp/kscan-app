package com.kscan.metawearable

import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellationException

/**
 * React Native / Expo boundary for the Meta glasses adapter.
 *
 * This class deliberately contains no Meta DAT symbol. It owns three things:
 *
 *  1. **Guards** - OS floor and initialization state are checked here, so a
 *     call that cannot possibly succeed fails deterministically instead of
 *     racing into the SDK.
 *  2. **Error translation** - every [MetaWearableException] becomes a JS error
 *     whose `code` is a stable K Scan constant. Anything else (a genuine
 *     Kotlin bug, an SDK crash) is flattened to a single opaque code rather
 *     than leaking a native stack trace across the bridge.
 *  3. **Listener lifetime** - exactly one native observer is attached, and it
 *     is closed on module destroy. Re-entrant `addListener` calls from JS do
 *     not stack up additional native subscriptions.
 *
 * All work is delegated to [MetaWearableEngine].
 */
class MetaWearableModule : Module() {

  private val engine get() = MetaWearableEngineFactory.engine
  private var observer: AutoCloseable? = null

  /** DAT requires Android 10+. Below that the adapter is permanently unavailable. */
  private fun requireSupportedOs() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      throw MetaWearableException(
        MetaWearableCodes.UNSUPPORTED_OS,
        "The Meta Wearables Device Access Toolkit requires Android 10 (API 29) or newer.",
      )
    }
  }

  private fun requireReady() {
    requireSupportedOs()
    if (engine.initState != MetaInitState.READY) {
      throw MetaWearableException(
        MetaWearableCodes.NOT_INITIALIZED,
        "Call initialize() and wait for READY before using the adapter.",
      )
    }
  }

  private fun requireActivity() = appContext.currentActivity
    ?: throw MetaWearableException(
      MetaWearableCodes.NO_ACTIVITY,
      "This call must run while an Activity is in the foreground.",
    )

  /**
   * Runs [block], converting every failure into a coded JS error.
   *
   * Cancellation is re-thrown untouched so a cancelled JS promise settles as a
   * cancellation rather than as a spurious adapter failure - the distinction
   * matters because a cancelled capture must not be reported as a device fault.
   */
  private inline fun <T> guarded(block: () -> T): T = try {
    block()
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (typed: MetaWearableException) {
    throw CodedException(typed.code, typed.message, null)
  } catch (unexpected: Throwable) {
    // Intentionally does not forward `unexpected` as the cause: its message can
    // carry SDK-internal detail (and, on a capture path, buffer information)
    // that has no business crossing into JavaScript.
    throw CodedException(
      MetaWearableCodes.INITIALIZATION_FAILED,
      "The Meta adapter failed unexpectedly.",
      null,
    )
  }

  override fun definition() = ModuleDefinition {
    Name("KScanMetaWearable")

    Events("onAdapterEvent")

    // ---- lifecycle -------------------------------------------------------

    OnCreate {
      observer = engine.observe { event, payload ->
        // Native events are forwarded under one channel with a discriminator,
        // so JS attaches a single listener and cannot end up with a partially
        // subscribed set after a reconnect.
        sendEvent("onAdapterEvent", mapOf("event" to event, "payload" to payload))
      }
    }

    OnDestroy {
      observer?.let { runCatching { it.close() } }
      observer = null
    }

    // ---- init / status ---------------------------------------------------

    Function("getStatus") {
      guarded { engine.status() }
    }

    AsyncFunction("initialize") {
      guarded {
        requireSupportedOs()
        val context = appContext.reactContext
          ?: throw MetaWearableException(MetaWearableCodes.NO_ACTIVITY, "No React context.")
        engine.initialize(context)
      }
    }

    // ---- registration ----------------------------------------------------

    AsyncFunction("startRegistration") {
      guarded {
        requireReady()
        engine.startRegistration(requireActivity())
      }
    }

    Function("registrationState") {
      guarded { engine.registrationState() }
    }

    // ---- devices ---------------------------------------------------------

    Function("listDevices") {
      guarded { engine.listDevices() }
    }

    Function("activeDevice") {
      guarded { engine.activeDevice() }
    }

    Function("deviceState") {
      guarded { engine.deviceState() }
    }

    // ---- permissions -----------------------------------------------------

    Function("cameraPermissionStatus") {
      guarded { engine.cameraPermissionStatus() }
    }

    AsyncFunction("requestCameraPermission") Coroutine { ->
      guarded { engine.requestCameraPermission(requireActivity()) }
    }

    // ---- session ---------------------------------------------------------

    AsyncFunction("createSession") Coroutine { ->
      requireReady()
      guarded { engine.createSession() }
    }

    AsyncFunction("startSession") Coroutine { ->
      requireReady()
      guarded { engine.startSession() }
    }

    AsyncFunction("stopSession") Coroutine { ->
      guarded { engine.stopSession() }
    }

    // ---- camera ----------------------------------------------------------

    AsyncFunction("attachCamera") Coroutine { config: Map<String, Any?> ->
      requireReady()
      guarded { engine.attachCamera(config) }
    }

    AsyncFunction("startCamera") Coroutine { ->
      requireReady()
      guarded { engine.startCamera() }
    }

    AsyncFunction("capturePhoto") Coroutine { timeoutMs: Long ->
      requireReady()
      guarded { engine.capturePhoto(timeoutMs) }
    }

    AsyncFunction("stopCamera") Coroutine { ->
      guarded { engine.stopCamera() }
    }

    // ---- display ---------------------------------------------------------

    Function("displayAvailable") {
      guarded { engine.displayAvailable() }
    }

    AsyncFunction("attachDisplay") Coroutine { ->
      requireReady()
      guarded { engine.attachDisplay() }
    }

    AsyncFunction("renderResult") Coroutine { payload: Map<String, Any?> ->
      requireReady()
      guarded { engine.renderResult(payload) }
    }

    AsyncFunction("clearDisplay") Coroutine { ->
      guarded { engine.clearDisplay() }
    }

    // ---- teardown --------------------------------------------------------

    AsyncFunction("disconnect") Coroutine { ->
      guarded { engine.disconnect() }
    }

    // ---- MockDeviceKit ---------------------------------------------------

    Function("mockSupported") {
      guarded { engine.mockSupported() }
    }

    AsyncFunction("mockEnable") Coroutine { config: Map<String, Any?> ->
      guarded { engine.mockEnable(config) }
    }

    AsyncFunction("mockPairGlasses") Coroutine { model: String ->
      guarded { engine.mockPairGlasses(model) }
    }

    AsyncFunction("mockSetDevicePower") Coroutine { on: Boolean ->
      guarded { engine.mockSetDevicePower(on) }
    }

    AsyncFunction("mockSetWorn") Coroutine { worn: Boolean ->
      guarded { engine.mockSetWorn(worn) }
    }

    AsyncFunction("mockDisconnect") Coroutine { ->
      guarded { engine.mockDisconnect() }
    }

    AsyncFunction("mockDisable") Coroutine { ->
      guarded { engine.mockDisable() }
    }
  }
}
