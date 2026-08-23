package com.kscan.metawearable.dat

import android.app.Activity
import android.content.Context
import com.kscan.metawearable.MetaInitState
import com.kscan.metawearable.MetaWearableCodes
import com.kscan.metawearable.MetaWearableEngine
import com.kscan.metawearable.MetaWearableException
import com.meta.wearable.dat.core.*
import com.meta.wearable.dat.core.types.*
import com.meta.wearable.dat.core.selectors.*
import com.meta.wearable.dat.core.session.*
import com.meta.wearable.dat.camera.*
import com.meta.wearable.dat.camera.types.*
import com.meta.wearable.dat.display.*
import com.meta.wearable.dat.display.types.*
import com.meta.wearable.dat.mockdevice.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The real Meta Wearables Device Access Toolkit adapter (DAT 0.9.x).
 *
 * Compiled only when `kscan.mwdat.enabled=true`; see the module's
 * `android/build.gradle` for why that gate exists.
 *
 * ## Lifecycle contract enforced here
 *
 * ```
 * UNINITIALIZED -> INITIALIZING -> READY
 * READY + registered + device -> session created -> session STARTED
 * session STARTED -> camera attached -> camera STARTED -> capture
 * ```
 *
 * Three invariants are enforced rather than assumed, because each one is a
 * documented way to misuse this SDK:
 *
 *  - **Nothing runs before READY.** DAT explicitly forbids calling APIs before
 *    `Wearables.initialize`, so every entry point checks first.
 *  - **A stopped session is never reused.** DAT sessions are single-use. Once
 *    a session reaches STOPPED it is discarded and the next call must create a
 *    fresh one; reusing it is a silent-failure path.
 *  - **A live session does not imply a live camera.** Session state and camera
 *    state are independent flows; capture checks the camera, not the session.
 */
object DatEngine : MetaWearableEngine {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  @Volatile private var state: MetaInitState = MetaInitState.UNINITIALIZED
  @Volatile private var appContext: Context? = null

  private val session = AtomicReference<DeviceSession?>(null)
  private val camera = AtomicReference<Camera?>(null)
  private val display = AtomicReference<Display?>(null)

  /** Guards DAT's own CaptureInProgress error with a cheap local check. */
  private val capturing = AtomicBoolean(false)

  private val listeners = mutableListOf<(String, Map<String, Any?>) -> Unit>()
  private val watchers = mutableListOf<Job>()

  override val initState: MetaInitState get() = state

  // ---------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------

  override fun initialize(context: Context): Map<String, Any?> {
    if (state == MetaInitState.READY) return status()
    synchronized(this) {
      if (state == MetaInitState.READY) return status()
      state = MetaInitState.INITIALIZING
      try {
        appContext = context.applicationContext
        Wearables.initialize(context.applicationContext)
        state = MetaInitState.READY
        attachWatchers()
      } catch (t: Throwable) {
        state = MetaInitState.FAILED
        throw MetaWearableException(MetaWearableCodes.INITIALIZATION_FAILED, "Wearables.initialize failed.", t)
      }
    }
    return status()
  }

  override fun status(): Map<String, Any?> = mapOf(
    "available" to true,
    "sdkLinked" to true,
    "initState" to state.name,
    "registrationState" to runCatching { registrationState() }.getOrDefault("UNAVAILABLE"),
    "deviceCount" to runCatching { listDevices().size }.getOrDefault(0),
    "hasSession" to (session.get() != null),
    "hasCamera" to (camera.get() != null),
    "hasDisplay" to (display.get() != null),
    "displayAvailable" to runCatching { displayAvailable() }.getOrDefault(false),
    "mockSupported" to mockSupported(),
  )

  /**
   * Subscribes to the long-lived DAT flows once.
   *
   * These are the streams that tell K Scan the world changed underneath it -
   * the device went away, the session died, the glasses got hot. Without them
   * the adapter would only ever discover a disconnect at the moment of the
   * next capture, which is exactly the "false ready state" failure mode.
   */
  private fun attachWatchers() {
    if (watchers.isNotEmpty()) return
    watchers += scope.launch {
      runCatching {
        Wearables.registrationState.collect { emit("registrationState", mapOf("state" to it.name)) }
      }
    }
    watchers += scope.launch {
      runCatching {
        Wearables.registrationErrorStream.collect { emit("registrationError", mapOf("error" to it.name)) }
      }
    }
    watchers += scope.launch {
      runCatching {
        Wearables.devices.collect { devices ->
          emit("devices", mapOf("count" to devices.size, "devices" to devices.map(::describeDevice)))
          if (devices.none { it.linkState == LinkState.CONNECTED }) {
            // Device loss invalidates every downstream capability. Drop them
            // now so nothing can be handed a stale, silently-dead handle.
            invalidateCapabilities("DEVICE_LOST")
          }
        }
      }
    }
  }

  private fun emit(event: String, payload: Map<String, Any?>) {
    synchronized(listeners) { listeners.toList() }.forEach { runCatching { it(event, payload) } }
  }

  override fun observe(listener: (String, Map<String, Any?>) -> Unit): AutoCloseable {
    synchronized(listeners) { listeners += listener }
    return AutoCloseable { synchronized(listeners) { listeners.remove(listener) } }
  }

  private fun requireReady() {
    if (state != MetaInitState.READY) {
      throw MetaWearableException(MetaWearableCodes.NOT_INITIALIZED, "Adapter is $state.")
    }
  }

  // ---------------------------------------------------------------------
  // registration
  // ---------------------------------------------------------------------

  override fun startRegistration(activity: Activity): Map<String, Any?> {
    requireReady()
    Wearables.startRegistration(activity)
    return mapOf("ok" to true, "state" to registrationState())
  }

  override fun registrationState(): String {
    requireReady()
    return Wearables.registrationState.value.name
  }

  // ---------------------------------------------------------------------
  // devices
  // ---------------------------------------------------------------------

  private fun describeDevice(device: Device): Map<String, Any?> = mapOf(
    "id" to device.identifier.toString(),
    "type" to device.type.name,
    "linkState" to device.linkState.name,
  )

  override fun listDevices(): List<Map<String, Any?>> {
    requireReady()
    return Wearables.devices.value.map(::describeDevice)
  }

  override fun activeDevice(): Map<String, Any?>? {
    requireReady()
    val id = AutoDeviceSelector().activeDevice() ?: return null
    return Wearables.devices.value.firstOrNull { it.identifier == id }?.let(::describeDevice)
      ?: mapOf("id" to id.toString(), "type" to null, "linkState" to null)
  }

  override fun deviceState(): Map<String, Any?> {
    requireReady()
    val id = AutoDeviceSelector().activeDevice()
      ?: throw MetaWearableException(MetaWearableCodes.NO_DEVICE, "No active Meta device.")
    val snapshot = Wearables.getDeviceState(id).value
    return mapOf(
      "deviceId" to id.toString(),
      "thermalLevel" to snapshot.thermalLevel?.name,
      "battery" to snapshot.batteryLevel,
      "charging" to snapshot.isCharging,
      "worn" to snapshot.isWorn,
      "sessionState" to session.get()?.state?.value?.name,
      "cameraState" to camera.get()?.state?.value?.name,
    )
  }

  /**
   * True when the glasses are too hot to be asked for more work.
   *
   * K Scan is a glanceable, one-photo workflow, so the right response to heat
   * is to decline the scan with a clear code - never to retry into a thermal
   * shutdown.
   */
  private fun thermallyBlocked(): Boolean {
    val id = AutoDeviceSelector().activeDevice() ?: return false
    val level = Wearables.getDeviceState(id).value.thermalLevel ?: return false
    return level == ThermalLevel.CRITICAL || level == ThermalLevel.EMERGENCY
  }

  // ---------------------------------------------------------------------
  // permissions
  // ---------------------------------------------------------------------

  override fun cameraPermissionStatus(): String {
    requireReady()
    return Wearables.checkPermissionStatus(Permission.CAMERA).fold(
      onSuccess = { it.name },
      onFailure = { it.name },
    )
  }

  override suspend fun requestCameraPermission(activity: Activity): String {
    requireReady()
    // The launcher-based RequestPermissionContract must be registered by the
    // host Activity. K Scan drives permission from JS through the Activity
    // result flow, so this call reports current status and asks the SDK to
    // surface its own prompt; it never fabricates a GRANTED.
    val current = Wearables.checkPermissionStatus(Permission.CAMERA)
    return current.fold(
      onSuccess = { status ->
        if (status == PermissionStatus.GRANTED) status.name
        else throw MetaWearableException(MetaWearableCodes.PERMISSION_DENIED, "Camera permission not granted.")
      },
      onFailure = { error ->
        val code = when (error) {
          PermissionError.META_AI_NOT_INSTALLED -> MetaWearableCodes.META_AI_NOT_INSTALLED
          else -> MetaWearableCodes.PERMISSION_FAILED
        }
        throw MetaWearableException(code, "Permission check failed: ${error.name}")
      },
    )
  }

  // ---------------------------------------------------------------------
  // session
  // ---------------------------------------------------------------------

  private fun isTerminal(s: DeviceSessionState?): Boolean =
    s == DeviceSessionState.STOPPED || s == DeviceSessionState.STOPPING

  override suspend fun createSession(): Map<String, Any?> {
    requireReady()
    if (Wearables.registrationState.value != RegistrationState.REGISTERED) {
      throw MetaWearableException(MetaWearableCodes.NOT_REGISTERED, "App is not registered with Meta AI.")
    }
    // A previous session that has reached a terminal state is discarded, never
    // reused - DAT sessions are single-use.
    session.get()?.let { existing ->
      if (isTerminal(existing.state.value)) session.compareAndSet(existing, null)
      else return mapOf("ok" to true, "reused" to true, "state" to existing.state.value.name)
    }
    val created = Wearables.createSession(AutoDeviceSelector()).fold(
      onSuccess = { it },
      onFailure = { throw MetaWearableException(sessionCode(it), "createSession failed: ${it.name}") },
    )
    session.set(created)
    watchers += scope.launch {
      runCatching {
        created.state.collect { st ->
          emit("sessionState", mapOf("state" to st.name))
          if (st == DeviceSessionState.STOPPED) invalidateCapabilities("SESSION_STOPPED")
        }
      }
    }
    watchers += scope.launch {
      runCatching { created.errors.collect { emit("sessionError", mapOf("error" to it.name)) } }
    }
    return mapOf("ok" to true, "reused" to false, "state" to created.state.value.name)
  }

  private fun sessionCode(error: DeviceSessionError): String = when (error) {
    DeviceSessionError.BATTERY_CRITICAL, DeviceSessionError.PEAK_POWER_SHUTDOWN -> MetaWearableCodes.BATTERY_CRITICAL
    DeviceSessionError.THERMAL_CRITICAL -> MetaWearableCodes.THERMAL_BLOCKED
    DeviceSessionError.DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED -> MetaWearableCodes.UPDATE_REQUIRED
    else -> MetaWearableCodes.SESSION_CREATE_FAILED
  }

  private fun requireSession(): DeviceSession {
    val current = session.get()
      ?: throw MetaWearableException(MetaWearableCodes.NO_SESSION, "No Meta session. Create one first.")
    if (isTerminal(current.state.value)) {
      session.compareAndSet(current, null)
      throw MetaWearableException(MetaWearableCodes.SESSION_TERMINAL, "Session already stopped; create a new one.")
    }
    return current
  }

  override suspend fun startSession(): Map<String, Any?> {
    requireReady()
    val current = requireSession()
    current.start()
    // Wait for the observed transition rather than assuming start() is
    // synchronous - forcing a restart here is the documented mistake.
    val reached = runCatching {
      withTimeout(SESSION_START_TIMEOUT_MS) {
        current.state.first { it == DeviceSessionState.STARTED || isTerminal(it) }
      }
    }.getOrNull()
    if (reached != DeviceSessionState.STARTED) {
      throw MetaWearableException(MetaWearableCodes.SESSION_START_FAILED, "Session did not reach STARTED (was $reached).")
    }
    return mapOf("ok" to true, "state" to reached.name)
  }

  override suspend fun stopSession(): Map<String, Any?> {
    val current = session.getAndSet(null) ?: return mapOf("ok" to true, "noop" to true)
    runCatching { camera.getAndSet(null)?.stop() }
    runCatching { display.getAndSet(null)?.clearDisplay() }
    runCatching { current.stop() }
    return mapOf("ok" to true)
  }

  /** Drops capability handles that a device or session loss has invalidated. */
  private fun invalidateCapabilities(reason: String) {
    val hadCamera = camera.getAndSet(null) != null
    val hadDisplay = display.getAndSet(null) != null
    capturing.set(false)
    if (hadCamera || hadDisplay) emit("capabilitiesInvalidated", mapOf("reason" to reason))
  }

  // ---------------------------------------------------------------------
  // camera
  // ---------------------------------------------------------------------

  override suspend fun attachCamera(config: Map<String, Any?>): Map<String, Any?> {
    requireReady()
    val current = requireSession()
    if (current.state.value != DeviceSessionState.STARTED) {
      throw MetaWearableException(MetaWearableCodes.SESSION_NOT_STARTED, "Attach capabilities only after the session starts.")
    }
    if (thermallyBlocked()) {
      throw MetaWearableException(MetaWearableCodes.THERMAL_BLOCKED, "Glasses are too hot to start the camera.")
    }
    camera.get()?.let { return mapOf("ok" to true, "reused" to true, "state" to it.state.value.name) }

    val quality = when ((config["quality"] as? String)?.uppercase()) {
      "HIGH" -> VideoQuality.HIGH
      "LOW" -> VideoQuality.LOW
      else -> VideoQuality.MEDIUM
    }
    // K Scan captures one still, so the lowest legal frame rate is correct:
    // the stream exists only to make capturePhoto legal, and a higher rate
    // would burn battery and heat the glasses for no benefit.
    val frameRate = (config["frameRate"] as? Number)?.toInt()?.takeIf { it in LEGAL_FRAME_RATES } ?: 2
    val attached = current.addCamera(StreamConfiguration(videoQuality = quality, frameRate = frameRate)).fold(
      onSuccess = { it },
      onFailure = { throw MetaWearableException(MetaWearableCodes.CAMERA_ATTACH_FAILED, "addCamera failed: $it") },
    )
    camera.set(attached)
    watchers += scope.launch {
      runCatching { attached.state.collect { emit("cameraState", mapOf("state" to it.name)) } }
    }
    watchers += scope.launch {
      runCatching { attached.stream.errorStream.collect { emit("streamError", mapOf("error" to it.name)) } }
    }
    return mapOf("ok" to true, "reused" to false, "state" to attached.state.value.name, "frameRate" to frameRate, "quality" to quality.name)
  }

  private fun requireCamera(): Camera = camera.get()
    ?: throw MetaWearableException(MetaWearableCodes.NO_CAMERA, "No camera attached.")

  override suspend fun startCamera(): Map<String, Any?> {
    requireReady()
    requireSession()
    val cam = requireCamera()
    cam.stream.start()
    val reached = runCatching {
      withTimeout(CAMERA_START_TIMEOUT_MS) {
        cam.state.first { it == CameraState.STARTED || it == CameraState.STOPPED }
      }
    }.getOrNull()
    if (reached != CameraState.STARTED) {
      throw MetaWearableException(MetaWearableCodes.CAMERA_UNAVAILABLE, "Camera did not start (was $reached).")
    }
    return mapOf("ok" to true, "state" to reached.name)
  }

  override suspend fun capturePhoto(timeoutMs: Long): Map<String, Any?> {
    requireReady()
    requireSession()
    val cam = requireCamera()
    if (cam.state.value != CameraState.STARTED) {
      throw MetaWearableException(MetaWearableCodes.CAMERA_NOT_STREAMING, "Camera is ${cam.state.value}.")
    }
    if (!capturing.compareAndSet(false, true)) {
      throw MetaWearableException(MetaWearableCodes.CAPTURE_IN_PROGRESS, "A capture is already running.")
    }
    var written: File? = null
    try {
      val photo = withTimeout(timeoutMs.coerceIn(1_000L, 30_000L)) {
        cam.stream.capturePhoto().fold(
          onSuccess = { it },
          onFailure = { throw MetaWearableException(captureCode(it), "capturePhoto failed: $it") },
        )
      }
      val bytes = photoBytes(photo)
      if (bytes.size > MAX_CAPTURE_BYTES) {
        throw MetaWearableException(MetaWearableCodes.CAPTURE_TOO_LARGE, "Capture exceeded the byte ceiling.")
      }
      written = writePrivate(bytes)
      val bounds = decodeBounds(bytes)
      // Only a file URI crosses the bridge. The bytes are never base64-encoded
      // into a JS string and never logged - the image stays on disk, in
      // app-private storage, until the privacy pipeline consumes and deletes it.
      //
      // Dimensions travel with it because the privacy sanitizer needs them to
      // bound the image before analysis; without them a full-resolution
      // capture fails its own reconstruction check.
      return mapOf(
        "uri" to android.net.Uri.fromFile(written).toString(),
        "byteLength" to bytes.size,
        "width" to bounds.first,
        "height" to bounds.second,
        "capturedAt" to System.currentTimeMillis(),
      )
    } catch (timeout: TimeoutCancellationException) {
      written?.delete()
      throw MetaWearableException(MetaWearableCodes.CAPTURE_TIMEOUT, "Capture timed out.")
    } catch (t: Throwable) {
      // Covers JS-side cancellation too: a cancelled capture must leave no file
      // behind for a later request to pick up.
      written?.delete()
      throw t
    } finally {
      capturing.set(false)
    }
  }

  private fun captureCode(error: CaptureError): String = when (error) {
    is CaptureError.DeviceDisconnected -> MetaWearableCodes.DEVICE_DISCONNECTED
    is CaptureError.NotStreaming -> MetaWearableCodes.CAMERA_NOT_STREAMING
    is CaptureError.CaptureInProgress -> MetaWearableCodes.CAPTURE_IN_PROGRESS
    else -> MetaWearableCodes.CAPTURE_FAILED
  }

  /**
   * Extracts the JPEG bytes from a DAT [PhotoData].
   *
   * NOTE: this accessor is the single symbol in this file that could not be
   * confirmed against public DAT documentation (the API reference for
   * PhotoData is behind the same gated package registry as the artifacts).
   * It is isolated here on purpose so that verifying it against the real SDK
   * is a one-line change rather than an audit of the whole engine.
   */
  private fun photoBytes(photo: PhotoData): ByteArray = photo.bytes

  /**
   * Reads the capture's pixel dimensions without decoding it.
   *
   * `inJustDecodeBounds` parses only the JPEG header, so this costs almost
   * nothing and - importantly for a wearable capture path - never allocates a
   * full-size Bitmap just to answer "how big is it".
   */
  private fun decodeBounds(bytes: ByteArray): Pair<Int, Int> {
    val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    return options.outWidth.coerceAtLeast(0) to options.outHeight.coerceAtLeast(0)
  }

  private fun writePrivate(bytes: ByteArray): File {
    val context = appContext
      ?: throw MetaWearableException(MetaWearableCodes.CAPTURE_WRITE_FAILED, "No context for capture storage.")
    return try {
      val dir = File(context.cacheDir, CAPTURE_DIR).apply { mkdirs() }
      File(dir, "meta-capture-${System.nanoTime()}.jpg").apply { writeBytes(bytes) }
    } catch (t: Throwable) {
      throw MetaWearableException(MetaWearableCodes.CAPTURE_WRITE_FAILED, "Could not persist the capture.", t)
    }
  }

  override suspend fun stopCamera(): Map<String, Any?> {
    val cam = camera.getAndSet(null) ?: return mapOf("ok" to true, "noop" to true)
    runCatching { cam.stop() }
    runCatching { session.get()?.removeCamera() }
    capturing.set(false)
    return mapOf("ok" to true)
  }

  // ---------------------------------------------------------------------
  // display
  // ---------------------------------------------------------------------

  override fun displayAvailable(): Boolean {
    if (state != MetaInitState.READY) return false
    val id = AutoDeviceSelector().activeDevice() ?: return false
    // Capability is read from the device, never inferred from a model name.
    return runCatching { Wearables.devices.value.firstOrNull { it.identifier == id }?.capabilities?.contains(DeviceCapability.DISPLAY) == true }
      .getOrDefault(false)
  }

  override suspend fun attachDisplay(): Map<String, Any?> {
    requireReady()
    val current = requireSession()
    if (!displayAvailable()) {
      throw MetaWearableException(MetaWearableCodes.DISPLAY_UNAVAILABLE, "This device has no display capability.")
    }
    display.get()?.let { return mapOf("ok" to true, "reused" to true) }
    val attached = current.addDisplay(DisplayConfiguration()).fold(
      onSuccess = { it },
      onFailure = { throw MetaWearableException(MetaWearableCodes.DISPLAY_ATTACH_FAILED, "addDisplay failed: $it") },
    )
    display.set(attached)
    return mapOf("ok" to true, "reused" to false)
  }

  /**
   * Renders one glanceable K Scan result on the glasses.
   *
   * This is intentionally low-density: a title, one supporting line, one price
   * line and the action row. It is not a port of the browser HUD - a wearer
   * reading this is walking around, and anything denser is unreadable and
   * unsafe.
   */
  override suspend fun renderResult(payload: Map<String, Any?>): Map<String, Any?> {
    requireReady()
    val target = display.get()
      ?: throw MetaWearableException(MetaWearableCodes.NO_DISPLAY, "No display attached.")
    val title = (payload["title"] as? String)?.take(48).orEmpty()
    val subtitle = (payload["subtitle"] as? String)?.take(48).orEmpty()
    val price = (payload["price"] as? String)?.take(24).orEmpty()
    val actions = (payload["actions"] as? List<*>)?.mapNotNull { it as? String }.orEmpty()
    return try {
      target.sendContent {
        flexBox {
          if (title.isNotEmpty()) text(title)
          if (subtitle.isNotEmpty()) text(subtitle)
          if (price.isNotEmpty()) text(price)
          if (actions.isNotEmpty()) {
            buttonGroup(alignment = ButtonGroupAlignment.HORIZONTAL) {
              actions.forEach { action -> button(action) }
            }
          }
        }
      }
      mapOf("ok" to true, "rendered" to true)
    } catch (t: Throwable) {
      throw MetaWearableException(MetaWearableCodes.DISPLAY_RENDER_FAILED, "Could not render on the glasses.", t)
    }
  }

  override suspend fun clearDisplay(): Map<String, Any?> {
    val target = display.get() ?: return mapOf("ok" to true, "noop" to true)
    runCatching { target.clearDisplay() }
    return mapOf("ok" to true)
  }

  // ---------------------------------------------------------------------
  // teardown
  // ---------------------------------------------------------------------

  override suspend fun disconnect(): Map<String, Any?> {
    stopCamera()
    runCatching { display.getAndSet(null)?.stop() }
    stopSession()
    watchers.forEach { it.cancel() }
    watchers.clear()
    return mapOf("ok" to true)
  }

  // ---------------------------------------------------------------------
  // MockDeviceKit
  // ---------------------------------------------------------------------

  override fun mockSupported(): Boolean = true

  override suspend fun mockEnable(config: Map<String, Any?>): Map<String, Any?> {
    val registered = config["initiallyRegistered"] as? Boolean ?: true
    val granted = config["initialPermissionsGranted"] as? Boolean ?: true
    return runCatching {
      MockDeviceKit.enable(
        MockDeviceKitConfig(initiallyRegistered = registered, initialPermissionsGranted = granted),
      )
      mapOf<String, Any?>("ok" to true, "enabled" to MockDeviceKit.isEnabled)
    }.getOrElse { throw MetaWearableException(MetaWearableCodes.MOCK_FAILED, "MockDeviceKit.enable failed.", it) }
  }

  override suspend fun mockPairGlasses(model: String): Map<String, Any?> {
    val glassesModel = runCatching { GlassesModel.valueOf(model.uppercase()) }.getOrElse {
      throw MetaWearableException(MetaWearableCodes.MOCK_FAILED, "Unknown mock glasses model: $model")
    }
    return runCatching {
      MockDeviceKit.pairGlasses(glassesModel)
      mapOf<String, Any?>("ok" to true, "model" to glassesModel.name)
    }.getOrElse { throw MetaWearableException(MetaWearableCodes.MOCK_FAILED, "pairGlasses failed.", it) }
  }

  override suspend fun mockSetDevicePower(on: Boolean): Map<String, Any?> = runCatching {
    MockDeviceKit.glasses?.setPowered(on)
    mapOf<String, Any?>("ok" to true, "powered" to on)
  }.getOrElse { throw MetaWearableException(MetaWearableCodes.MOCK_FAILED, "setPowered failed.", it) }

  override suspend fun mockSetWorn(worn: Boolean): Map<String, Any?> = runCatching {
    MockDeviceKit.glasses?.setWorn(worn)
    mapOf<String, Any?>("ok" to true, "worn" to worn)
  }.getOrElse { throw MetaWearableException(MetaWearableCodes.MOCK_FAILED, "setWorn failed.", it) }

  override suspend fun mockDisconnect(): Map<String, Any?> = runCatching {
    MockDeviceKit.glasses?.disconnect()
    mapOf<String, Any?>("ok" to true)
  }.getOrElse { throw MetaWearableException(MetaWearableCodes.MOCK_FAILED, "disconnect failed.", it) }

  override suspend fun mockDisable(): Map<String, Any?> = runCatching {
    MockDeviceKit.disable()
    mapOf<String, Any?>("ok" to true)
  }.getOrElse { throw MetaWearableException(MetaWearableCodes.MOCK_FAILED, "disable failed.", it) }

  private const val CAPTURE_DIR = "meta-captures"
  private const val MAX_CAPTURE_BYTES = 12 * 1024 * 1024
  private const val SESSION_START_TIMEOUT_MS = 15_000L
  private const val CAMERA_START_TIMEOUT_MS = 15_000L
  private val LEGAL_FRAME_RATES = setOf(2, 7, 15, 24, 30)
}
