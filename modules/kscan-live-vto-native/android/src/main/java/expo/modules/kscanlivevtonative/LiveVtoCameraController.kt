package expo.modules.kscanlivevtonative

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private const val TAG = "KScanLiveVtoCamera"

enum class CameraControllerState {
  IDLE,
  STARTING,
  RUNNING,
  PERMISSION_DENIED,
  ERROR,
  STOPPED,
}

/**
 * N1-F: wires CameraX `Preview` + `ImageAnalysis` (front camera) into the
 * EXISTING native runtime (mission section 7). Owns exactly the camera
 * lifecycle and nothing downstream of it -- no landmark, no BodyFrame, no
 * geometry, no Canvas. `ImageAnalysis`'s own `STRATEGY_KEEP_ONLY_LATEST`
 * plus this class's own `LatestStateSlot` (the SAME bounded primitive N1-D/
 * N1-E already proved -- `LiveVtoReplayRuntime.kt`) give the camera boundary
 * mission section 8's "latest-useful-frame, bounded pending, stale-frame
 * dropping" without inventing a second design for it.
 *
 * Permission (mission section 16): this class checks
 * `Manifest.permission.CAMERA` itself and fails closed to
 * `PERMISSION_DENIED` rather than letting CameraX throw a `SecurityException`
 * mid-bind. It does not request the permission -- the JS-side capability/
 * permission flow (`services/vto/vtoLiveCameraPermission.ts`) already owns
 * that UX; this is the native-side fail-closed backstop for whatever state
 * the OS is actually in when `start()` is called, including a mid-session
 * revocation on the next attempted (re)start.
 */
class LiveVtoCameraController(
  private val context: Context,
  private val lifecycleOwner: LifecycleOwner,
  private val previewView: PreviewView,
  private val onStateChanged: (CameraControllerState, String?) -> Unit = { _, _ -> },
) {
  /** Camera -> perception-producer boundary. Bounded: at most one pending frame. */
  val frameSlot = LatestStateSlot<PerceptionInputFrame>()

  @Volatile var state: CameraControllerState = CameraControllerState.IDLE
    private set

  private var cameraProvider: ProcessCameraProvider? = null
  private var analysisExecutor: ExecutorService? = null

  fun start() {
    if (state == CameraControllerState.STARTING || state == CameraControllerState.RUNNING) return
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      transition(CameraControllerState.PERMISSION_DENIED, "android.permission.CAMERA not granted")
      return
    }
    transition(CameraControllerState.STARTING, null)
    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener(
      {
        try {
          val provider = providerFuture.get()
          cameraProvider = provider
          bind(provider)
        } catch (t: Throwable) {
          Log.e(TAG, "camera provider bind failed", t)
          transition(CameraControllerState.ERROR, t.message ?: t.toString())
        }
      },
      ContextCompat.getMainExecutor(context),
    )
  }

  private fun bind(provider: ProcessCameraProvider) {
    // N1-F binds its OWN use cases exclusively -- `unbindAll()` releases
    // whatever a previous Live VTO session left bound (safe: this class is
    // the only owner of camera use cases across `start`/`stop`/`dispose`
    // per mission section 15's "exactly one session owns the camera").
    // Known, documented, prototype-scope constraint: `ProcessCameraProvider`
    // is process-wide, so this WOULD also unbind a concurrently-active
    // camera use case from an unrelated feature (e.g. the main Scan
    // camera) if both were bound at once. Not exercised in normal
    // navigation (Live VTO and Scan are different screens) and out of
    // scope to solve here per mission section 5's scope fence.
    provider.unbindAll()

    val preview = androidx.camera.core.Preview.Builder().build().also {
      it.setSurfaceProvider(previewView.surfaceProvider)
    }

    val executor = Executors.newSingleThreadExecutor { r -> Thread(r, ANALYSIS_THREAD_NAME).apply { isDaemon = true } }
    analysisExecutor = executor

    val analysis = ImageAnalysis.Builder()
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build()
    analysis.setAnalyzer(executor) { imageProxy ->
      try {
        val bitmap = LiveVtoCameraFrameConverter.toBitmap(imageProxy, mirror = true)
        frameSlot.publish(BitmapPerceptionInputFrame(bitmap))
      } catch (t: Throwable) {
        Log.e(TAG, "camera frame conversion failed", t)
      } finally {
        // MUST close every ImageProxy exactly once, even on failure -- an
        // unclosed ImageProxy starves CameraX's own buffer pool and stalls
        // the analyzer permanently, which would look like "camera frozen"
        // with no exception anywhere obvious.
        imageProxy.close()
      }
    }

    try {
      provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_FRONT_CAMERA, preview, analysis)
      transition(CameraControllerState.RUNNING, null)
    } catch (t: Throwable) {
      Log.e(TAG, "bindToLifecycle failed", t)
      transition(CameraControllerState.ERROR, t.message ?: t.toString())
    }
  }

  /** Called by the perception producer tick. Never blocks; never invents a frame when none has arrived. */
  fun latestFrame(): PerceptionInputFrame? = frameSlot.consume()

  fun stop() {
    if (state == CameraControllerState.IDLE || state == CameraControllerState.STOPPED) return
    try {
      cameraProvider?.unbindAll()
    } catch (t: Throwable) {
      Log.e(TAG, "unbindAll on stop threw (ignored, stopping anyway)", t)
    }
    cameraProvider = null
    analysisExecutor?.shutdown()
    analysisExecutor = null
    frameSlot.clear()
    transition(CameraControllerState.STOPPED, null)
  }

  private fun transition(next: CameraControllerState, reason: String?) {
    state = next
    onStateChanged(next, reason)
  }

  companion object {
    const val ANALYSIS_THREAD_NAME = "kscan-live-vto-camera-analysis"
  }
}
