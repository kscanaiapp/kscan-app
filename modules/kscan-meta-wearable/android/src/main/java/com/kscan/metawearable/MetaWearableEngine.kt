package com.kscan.metawearable

import android.app.Activity
import android.content.Context

/**
 * Typed failure surface for the whole adapter.
 *
 * Every DAT `DatResult` failure, every lifecycle violation and every guard in
 * this module funnels into one of these codes. The React Native bridge maps
 * them 1:1 onto a JS error `code`, so no raw Kotlin exception, DAT enum name
 * or stack trace ever reaches JavaScript.
 */
class MetaWearableException(
  val code: String,
  message: String? = null,
  cause: Throwable? = null,
) : Exception(message ?: code, cause)

object MetaWearableCodes {
  // Adapter / environment
  const val ADAPTER_UNAVAILABLE = "META_ADAPTER_UNAVAILABLE"
  const val UNSUPPORTED_OS = "META_UNSUPPORTED_OS"
  const val NOT_INITIALIZED = "META_NOT_INITIALIZED"
  const val INITIALIZATION_FAILED = "META_INITIALIZATION_FAILED"
  const val NO_ACTIVITY = "META_NO_ACTIVITY"

  // Registration
  const val NOT_REGISTERED = "META_NOT_REGISTERED"
  const val REGISTRATION_FAILED = "META_REGISTRATION_FAILED"
  const val META_AI_NOT_INSTALLED = "META_AI_NOT_INSTALLED"
  const val UPDATE_REQUIRED = "META_UPDATE_REQUIRED"

  // Devices
  const val NO_DEVICE = "META_NO_DEVICE"
  const val DEVICE_DISCONNECTED = "META_DEVICE_DISCONNECTED"

  // Session
  const val SESSION_CREATE_FAILED = "META_SESSION_CREATE_FAILED"
  const val SESSION_START_FAILED = "META_SESSION_START_FAILED"
  const val NO_SESSION = "META_NO_SESSION"
  const val SESSION_TERMINAL = "META_SESSION_TERMINAL"
  const val SESSION_NOT_STARTED = "META_SESSION_NOT_STARTED"

  // Permissions
  const val PERMISSION_DENIED = "META_PERMISSION_DENIED"
  const val PERMISSION_FAILED = "META_PERMISSION_FAILED"

  // Camera
  const val CAMERA_UNAVAILABLE = "META_CAMERA_UNAVAILABLE"
  const val CAMERA_ATTACH_FAILED = "META_CAMERA_ATTACH_FAILED"
  const val NO_CAMERA = "META_NO_CAMERA"
  const val CAMERA_NOT_STREAMING = "META_CAMERA_NOT_STREAMING"
  const val CAPTURE_IN_PROGRESS = "META_CAPTURE_IN_PROGRESS"
  const val CAPTURE_FAILED = "META_CAPTURE_FAILED"
  const val CAPTURE_TIMEOUT = "META_CAPTURE_TIMEOUT"
  const val CAPTURE_CANCELLED = "META_CAPTURE_CANCELLED"
  const val CAPTURE_TOO_LARGE = "META_CAPTURE_TOO_LARGE"
  const val CAPTURE_WRITE_FAILED = "META_CAPTURE_WRITE_FAILED"

  // Thermal / power
  const val THERMAL_BLOCKED = "META_THERMAL_BLOCKED"
  const val BATTERY_CRITICAL = "META_BATTERY_CRITICAL"

  // Display
  const val DISPLAY_UNAVAILABLE = "META_DISPLAY_UNAVAILABLE"
  const val DISPLAY_ATTACH_FAILED = "META_DISPLAY_ATTACH_FAILED"
  const val NO_DISPLAY = "META_NO_DISPLAY"
  const val DISPLAY_RENDER_FAILED = "META_DISPLAY_RENDER_FAILED"

  // Mock
  const val MOCK_UNAVAILABLE = "META_MOCK_UNAVAILABLE"
  const val MOCK_FAILED = "META_MOCK_FAILED"
}

/** Adapter initialization state. Nothing may run before READY. */
enum class MetaInitState { UNINITIALIZED, INITIALIZING, READY, FAILED }

/**
 * The whole native surface K Scan needs, expressed without a single DAT type.
 *
 * Keeping this interface DAT-free is what lets the default (flag-off) build
 * compile and ship with no access to the private Meta package repository. The
 * real implementation lives in the `mwdat` source set and is resolved by name
 * at runtime - see [MetaWearableEngineFactory].
 *
 * Every method either returns a plain bridge-safe map or throws
 * [MetaWearableException]. Suspending methods are cancellable; cancelling one
 * must leave no capture, buffer or temporary file behind.
 */
interface MetaWearableEngine {
  val initState: MetaInitState

  fun initialize(context: Context): Map<String, Any?>
  fun status(): Map<String, Any?>

  fun startRegistration(activity: Activity): Map<String, Any?>
  fun registrationState(): String

  fun listDevices(): List<Map<String, Any?>>
  fun activeDevice(): Map<String, Any?>?
  fun deviceState(): Map<String, Any?>

  fun cameraPermissionStatus(): String
  suspend fun requestCameraPermission(activity: Activity): String

  suspend fun createSession(): Map<String, Any?>
  suspend fun startSession(): Map<String, Any?>
  suspend fun stopSession(): Map<String, Any?>

  suspend fun attachCamera(config: Map<String, Any?>): Map<String, Any?>
  suspend fun startCamera(): Map<String, Any?>

  /** Captures one still and writes it to app-private storage; returns a file URI. */
  suspend fun capturePhoto(timeoutMs: Long): Map<String, Any?>
  suspend fun stopCamera(): Map<String, Any?>

  fun displayAvailable(): Boolean
  suspend fun attachDisplay(): Map<String, Any?>
  suspend fun renderResult(payload: Map<String, Any?>): Map<String, Any?>
  suspend fun clearDisplay(): Map<String, Any?>

  suspend fun disconnect(): Map<String, Any?>

  /** Registers a listener for asynchronous transitions; returns a detach handle. */
  fun observe(listener: (event: String, payload: Map<String, Any?>) -> Unit): AutoCloseable

  // MockDeviceKit - present only when the mwdat source set is compiled in.
  fun mockSupported(): Boolean
  suspend fun mockEnable(config: Map<String, Any?>): Map<String, Any?>
  suspend fun mockPairGlasses(model: String): Map<String, Any?>
  suspend fun mockSetDevicePower(on: Boolean): Map<String, Any?>
  suspend fun mockSetWorn(worn: Boolean): Map<String, Any?>
  suspend fun mockDisconnect(): Map<String, Any?>
  suspend fun mockDisable(): Map<String, Any?>
}

/**
 * The engine used whenever the DAT SDK was not compiled in.
 *
 * This is deliberately NOT a simulator: it never pretends a device, session or
 * capture exists. Every capability query answers "no" and every action fails
 * with ADAPTER_UNAVAILABLE, so a flag-off build degrades to the phone-camera
 * path instead of silently producing fabricated glasses results.
 */
object UnavailableEngine : MetaWearableEngine {
  override val initState = MetaInitState.UNINITIALIZED

  private fun unavailable(): Nothing = throw MetaWearableException(
    MetaWearableCodes.ADAPTER_UNAVAILABLE,
    "The Meta Wearables Device Access Toolkit was not compiled into this build.",
  )

  override fun initialize(context: Context) = status()

  override fun status(): Map<String, Any?> = mapOf(
    "available" to false,
    "initState" to MetaInitState.UNINITIALIZED.name,
    "sdkVersion" to BuildConfig.MWDAT_VERSION,
    "sdkLinked" to false,
    "reason" to "MWDAT_NOT_LINKED",
  )

  override fun startRegistration(activity: Activity) = unavailable()
  override fun registrationState() = "UNAVAILABLE"
  override fun listDevices() = emptyList<Map<String, Any?>>()
  override fun activeDevice(): Map<String, Any?>? = null
  override fun deviceState() = mapOf<String, Any?>("available" to false)
  override fun cameraPermissionStatus() = "DENIED"
  override suspend fun requestCameraPermission(activity: Activity) = unavailable()
  override suspend fun createSession() = unavailable()
  override suspend fun startSession() = unavailable()
  override suspend fun stopSession() = unavailable()
  override suspend fun attachCamera(config: Map<String, Any?>) = unavailable()
  override suspend fun startCamera() = unavailable()
  override suspend fun capturePhoto(timeoutMs: Long) = unavailable()
  override suspend fun stopCamera() = unavailable()
  override fun displayAvailable() = false
  override suspend fun attachDisplay() = unavailable()
  override suspend fun renderResult(payload: Map<String, Any?>) = unavailable()
  override suspend fun clearDisplay() = unavailable()
  override suspend fun disconnect() = mapOf<String, Any?>("ok" to true, "noop" to true)
  override fun observe(listener: (String, Map<String, Any?>) -> Unit) = AutoCloseable { }
  override fun mockSupported() = false
  override suspend fun mockEnable(config: Map<String, Any?>) = unavailable()
  override suspend fun mockPairGlasses(model: String) = unavailable()
  override suspend fun mockSetDevicePower(on: Boolean) = unavailable()
  override suspend fun mockSetWorn(worn: Boolean) = unavailable()
  override suspend fun mockDisconnect() = unavailable()
  override suspend fun mockDisable() = unavailable()
}

/**
 * Resolves the real DAT-backed engine by name, falling back to
 * [UnavailableEngine].
 *
 * Reflection is used on purpose: it is the one mechanism that lets the main
 * source set reference the DAT implementation without importing it, which is
 * exactly the property that keeps the flag-off build free of the private Meta
 * dependency. The lookup happens once.
 */
object MetaWearableEngineFactory {
  private const val DAT_ENGINE = "com.kscan.metawearable.dat.DatEngine"

  val engine: MetaWearableEngine by lazy {
    if (!BuildConfig.MWDAT_ENABLED) {
      UnavailableEngine
    } else {
      runCatching {
        Class.forName(DAT_ENGINE).getDeclaredField("INSTANCE").get(null) as MetaWearableEngine
      }.getOrDefault(UnavailableEngine)
    }
  }
}
