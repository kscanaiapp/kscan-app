package expo.modules.kscanlivevtonative

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult
import java.nio.ByteBuffer

private const val TAG = "KScanLiveVtoPerception"

/**
 * The real, provisional N1-E perception provider (mission sections 7-9).
 *
 * PROVIDER: MediaPipe Tasks Vision -- Pose Landmarker.
 * SDK: com.google.mediapipe:tasks-vision:1.0.0 (verified current against
 *      Google's own Maven metadata at integration time -- NOT assumed from
 *      an earlier release line; see docs/vto-live-native-n1-perception.md
 *      for the full provenance record and how it was checked).
 * MODEL: pose_landmarker_lite.task, bundled under
 *      android/src/main/assets/models/ -- never fetched at runtime.
 *
 * Chosen over a third-party React Native pose-detection wrapper per
 * mission section 9: this is a direct native/Expo integration (a plain
 * Android library called from this module's own Kotlin, exactly like any
 * other native dependency), not an RN bridge of someone else's wrapper --
 * cleaner, and fully independent of React Native's Old/New Architecture
 * either way, since it never touches the RN bridge or Fabric at all.
 *
 * FREEZE STATUS: TESTED CONFIGURATION, not a permanent product decision
 * (mission section 7). Sits entirely behind `PerceptionProvider`; swapping
 * providers later means writing a new class against that interface, not
 * touching the renderer, the replay runtime, or the BodyFrame adapter.
 */
class LiveVtoMediaPipePoseProvider(private val context: Context) : PerceptionProvider {

  private var landmarker: PoseLandmarker? = null
  private var state: PerceptionState = PerceptionState.UNINITIALIZED
  private var lastError: String? = null

  companion object {
    const val PROVIDER_NAME = "mediapipe-tasks-vision-pose-landmarker"
    const val MODEL_NAME = "pose_landmarker_lite"
    const val MODEL_ASSET_PATH = "models/pose_landmarker_lite.task"

    /**
     * Provisional thresholds, not tuned against real device data yet
     * (mission section 20). MediaPipe's own defaults are 0.5 for all
     * three; kept explicit here rather than left implicit, so a future
     * calibration pass has one place to change them.
     */
    const val MIN_POSE_DETECTION_CONFIDENCE = 0.5f
    const val MIN_POSE_PRESENCE_CONFIDENCE = 0.5f
    const val MIN_TRACKING_CONFIDENCE = 0.5f
  }

  /**
   * Loads the model as an in-memory `ByteBuffer` read directly from the
   * bundled APK asset, rather than `setModelAssetPath` (a string path the
   * SDK resolves itself). This is deliberate: reading the bytes ourselves
   * and handing MediaPipe a buffer it cannot resolve any other way removes
   * any possibility of the SDK's own asset-resolution logic reaching for
   * anything other than exactly these bytes -- the strongest available
   * guarantee against a silent path-based fallback to a different model
   * source (mission section 11/12).
   */
  private fun readModelBuffer(): ByteBuffer {
    context.assets.open(MODEL_ASSET_PATH).use { input ->
      val bytes = input.readBytes()
      val buffer = ByteBuffer.allocateDirect(bytes.size)
      buffer.put(bytes)
      buffer.rewind()
      return buffer
    }
  }

  override fun initialize(): Boolean {
    if (state == PerceptionState.READY) return true
    if (state == PerceptionState.DISPOSED) return false
    state = PerceptionState.INITIALIZING
    return try {
      val baseOptions = BaseOptions.builder()
        .setModelAssetBuffer(readModelBuffer())
        .build()
      val options = PoseLandmarker.PoseLandmarkerOptions.builder()
        .setBaseOptions(baseOptions)
        .setRunningMode(RunningMode.IMAGE) // N1-E: single-frame replay input, not a video/live stream yet
        .setNumPoses(1)
        .setMinPoseDetectionConfidence(MIN_POSE_DETECTION_CONFIDENCE)
        .setMinPosePresenceConfidence(MIN_POSE_PRESENCE_CONFIDENCE)
        .setMinTrackingConfidence(MIN_TRACKING_CONFIDENCE)
        .setOutputSegmentationMasks(false) // never request masks -- nothing downstream consumes them, and mission section 26 forbids mask data crossing the JS boundary regardless
        .build()
      landmarker = PoseLandmarker.createFromOptions(context, options)
      state = PerceptionState.READY
      lastError = null
      Log.d(TAG, "MediaPipe PoseLandmarker initialized: model=$MODEL_NAME sdk=tasks-vision:1.0.0")
      true
    } catch (t: Throwable) {
      lastError = t.message ?: t.toString()
      state = PerceptionState.ERROR
      Log.e(TAG, "PoseLandmarker initialization failed", t)
      false
    }
  }

  override fun getCapability(): PerceptionCapability = PerceptionCapability(
    moduleAvailable = true,
    perceptionReady = state == PerceptionState.READY,
    providerName = PROVIDER_NAME,
    modelName = MODEL_NAME,
    reason = lastError,
  )

  override fun processFrame(frame: PerceptionInputFrame): PerceptionResult {
    val activeLandmarker = landmarker
    if (state != PerceptionState.READY || activeLandmarker == null) {
      return PerceptionResult.Failure("PERCEPTION_NOT_READY (state=$state)")
    }
    val bitmapFrame = frame as? BitmapPerceptionInputFrame
      ?: return PerceptionResult.Failure("unsupported input frame type: ${frame::class.simpleName}")

    return try {
      state = PerceptionState.PROCESSING
      val mpImage = BitmapImageBuilder(bitmapFrame.bitmap).build()
      val result: PoseLandmarkerResult = activeLandmarker.detect(mpImage)
      state = PerceptionState.READY
      translate(result)
    } catch (t: Throwable) {
      state = PerceptionState.READY // a single bad frame must not wedge the provider
      Log.e(TAG, "processFrame threw", t)
      PerceptionResult.Failure(t.message ?: t.toString())
    }
  }

  /**
   * The ONLY place this file touches a MediaPipe result type. Everything
   * past this function is provider-agnostic `RawPoseFrame` -- see
   * LiveVtoPerceptionTypes.kt's header for why that boundary matters.
   */
  private var loggedOnce = false

  private fun translate(result: PoseLandmarkerResult): PerceptionResult {
    val poses = result.landmarks()
    if (!loggedOnce) {
      loggedOnce = true
      Log.d(TAG, "N1-E first detect() result: poses=" + poses.size +
        if (poses.isNotEmpty()) " landmarksInPose0=" + poses[0].size +
          " sample=" + poses[0].take(3).map { "(" + it.x() + "," + it.y() + ",vis=" + it.visibility().orElse(-1f) + ",pres=" + it.presence().orElse(-1f) + ")" }
        else "")
    }
    if (poses.isEmpty()) return PerceptionResult.NoPose("PoseLandmarkerResult.landmarks() was empty -- no pose detected")
    val landmarks = poses[0]
    if (landmarks.size < PoseLandmarkIndex.COUNT) {
      return PerceptionResult.NoPose("detected pose has ${landmarks.size} landmarks, expected ${PoseLandmarkIndex.COUNT}")
    }
    val raw = landmarks.map { lm ->
      RawPoseLandmark(
        x = lm.x(),
        y = lm.y(),
        confidence = lm.presence().orElse(lm.visibility().orElse(1f)),
        present = true, // MediaPipe's fixed-size landmark list has no concept of a missing index; low confidence is how absence is expressed
      )
    }
    return PerceptionResult.Success(
      RawPoseFrame(
        timestampMs = System.currentTimeMillis(),
        landmarks = raw,
        poseConfidence = raw.map { it.confidence }.average().toFloat(),
      ),
    )
  }

  override fun reset() {
    // MediaPipe's Landmarker is stateless per detect() call in IMAGE mode;
    // nothing to clear between frames. Kept as an explicit no-op rather
    // than omitted, so the interface's lifecycle stays uniform across
    // providers that DO carry state (e.g. a VIDEO-mode tracker would).
  }

  override fun dispose() {
    if (state == PerceptionState.DISPOSED) return
    try {
      landmarker?.close()
    } catch (t: Throwable) {
      Log.e(TAG, "PoseLandmarker close threw (ignored, disposing anyway)", t)
    }
    landmarker = null
    state = PerceptionState.DISPOSED
  }
}

/** The real Android-side `PerceptionInputFrame`: a decoded bitmap and nothing else. */
class BitmapPerceptionInputFrame(val bitmap: Bitmap) : PerceptionInputFrame {
  override val width: Int get() = bitmap.width
  override val height: Int get() = bitmap.height
}
