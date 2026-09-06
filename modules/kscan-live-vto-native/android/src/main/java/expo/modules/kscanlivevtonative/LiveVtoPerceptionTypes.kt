package expo.modules.kscanlivevtonative

/**
 * The provider-agnostic perception contract (N1-E, mission section 6).
 *
 * Every real pose provider (MediaPipe today; anything else later) sits
 * behind this interface. Nothing provider-specific -- no MediaPipe type,
 * no vendor landmark index, no vendor confidence convention -- may escape
 * past `LiveVtoBodyFrameAdapter` into the renderer, the replay runtime, or
 * the JS bridge (mission section 6: "Provider-specific landmark formats
 * must not escape into renderer / Live UI / Commerce / BodyFrame
 * consumers").
 *
 * `RawPoseFrame` is that boundary: it is this module's OWN minimal,
 * provider-agnostic shape, not a copy of any vendor's result type. A
 * provider implementation's only job is to translate its native result
 * into this shape; the adapter that turns `RawPoseFrame` into a governed
 * `BodyFrame` never touches a provider SDK type at all, which is what
 * keeps it runnable in a plain JVM test (amendment/D8-style reasoning,
 * applied here to perception).
 */

/** One landmark in normalized image-space [0,1], provider-reported confidence, and whether observed at all. */
data class RawPoseLandmark(
  val x: Float,
  val y: Float,
  val confidence: Float,
  /** True if the provider reported a value (however low-confidence). False = genuinely not observed this frame. */
  val present: Boolean,
)

/**
 * One inference result, indexed by the BlazePose/MediaPipe Pose 33-point
 * topology (stable across MediaPipe Tasks versions; verified against the
 * bundled 1.0.0 artifact's own `NormalizedLandmark` shape, not assumed).
 * Index `null` at a position that topology does not define is invalid;
 * an ABSENT landmark is `RawPoseLandmark(present = false, ...)`, never a
 * null list entry -- see `LiveVtoBodyFrameAdapter` for why that distinction
 * is load-bearing (N1-ENV-008's absent-vs-non-finite lesson, carried
 * forward into perception).
 */
data class RawPoseFrame(
  val timestampMs: Long,
  val landmarks: List<RawPoseLandmark>,
  /** Overall per-pose detection confidence from the provider, if it reports one. */
  val poseConfidence: Float,
)

/** BlazePose/MediaPipe Pose 33-point topology indices this adapter actually consumes. */
object PoseLandmarkIndex {
  const val NOSE = 0
  const val LEFT_SHOULDER = 11
  const val RIGHT_SHOULDER = 12
  const val LEFT_ELBOW = 13
  const val RIGHT_ELBOW = 14
  const val LEFT_WRIST = 15
  const val RIGHT_WRIST = 16
  const val LEFT_HIP = 23
  const val RIGHT_HIP = 24
  const val COUNT = 33
}

enum class PerceptionState {
  UNINITIALIZED,
  INITIALIZING,
  READY,
  PROCESSING,
  ERROR,
  DISPOSED,
}

/**
 * Truthful, evidence-backed capability -- mission section 29. `moduleAvailable`
 * is a compile/link fact; `perceptionReady` requires the model to have
 * actually loaded. Never report `perceptionReady: true` before that has
 * genuinely happened.
 */
data class PerceptionCapability(
  val moduleAvailable: Boolean,
  val perceptionReady: Boolean,
  val providerName: String,
  val modelName: String,
  val reason: String?,
)

/** One frame's inference outcome, including the fail-closed paths (section 22). */
sealed class PerceptionResult {
  data class Success(val frame: RawPoseFrame) : PerceptionResult()

  /** The provider ran but found no pose, or explicitly reported failure -- not the same as an exception. */
  data class NoPose(val reason: String) : PerceptionResult()

  /** initialize()/processFrame() threw, or was called out of sequence. Never crashes the caller. */
  data class Failure(val reason: String) : PerceptionResult()
}

/**
 * The provider contract every real pose backend implements.
 *
 * Lifecycle is strict: `initialize()` must complete (and return true)
 * before `processFrame()` is called; `processFrame()` after `dispose()`
 * must fail closed, never throw and never silently reuse a disposed
 * native handle (mission section 22).
 */
interface PerceptionProvider {
  fun initialize(): Boolean
  fun getCapability(): PerceptionCapability
  fun processFrame(frame: PerceptionInputFrame): PerceptionResult
  fun reset()
  fun dispose()
}

/**
 * A provider-agnostic input frame. Deliberately NOT an Android `Bitmap`
 * reference held here -- the interface is defined in terms of raw pixels
 * so the CONTRACT stays testable independent of any specific image type,
 * even though every real implementation today is Android/Bitmap-backed.
 */
interface PerceptionInputFrame {
  val width: Int
  val height: Int
}
