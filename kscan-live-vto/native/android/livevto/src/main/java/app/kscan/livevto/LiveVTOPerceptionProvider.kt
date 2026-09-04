// LiveVTOPerceptionProvider.kt
//
// STATUS: unbuilt scaffolding. Never compiled in this session — see
// native/README.md's "Emulator-native validation lane" section: this
// sandbox has no Android SDK, no emulator binary, no AVD image, no
// /dev/kvm for hardware-accelerated virtualization, AND this session's
// outbound network policy returns 403 for dl.google.com (the Android SDK
// / Google Maven host), which independently rules out even a compile-only
// Gradle attempt. All four are session/environment facts, not defects in
// this code.
//
// Kotlin mirror of ios/LiveVTOPerceptionProvider.swift — see that file's
// header for the Section 4 two-mode requirement this satisfies and the
// same caveats (RealLocalPoseProvider unimplemented pending
// docs/vto-native-device-handoff.md Section 2's device-measured pose-model
// decision; NativeReplayPerceptionProvider's validation is intentionally
// unported until a real test run exists to port it against).

package app.kscan.livevto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// ─── Frame source ────────────────────────────────────────────────────────────

/** Mirrors ios/LiveVTOPerceptionProvider.swift's FrameSource — see that file. */
enum class FrameSource(val wireValue: String) {
  EMULATOR_CAMERA("EMULATOR_CAMERA"),
  SIMULATOR_CAMERA("SIMULATOR_CAMERA"),
  NATIVE_REPLAY_FIXTURE("NATIVE_REPLAY_FIXTURE"),
}

// ─── BodyFrame (mirror of live-vto-contract's bodyFrame.ts) ─────────────────

@Serializable
data class Point2D(val u: Double, val v: Double)

/**
 * Mirrors bodyFrame.ts's `Landmark` discriminated union. Unlike the Swift
 * side (which decodes `present` directly against a Codable enum), this is
 * expressed as a sealed class so Kotlin exhaustiveness checking forces every
 * consumer to handle both cases explicitly — there is no default branch a
 * future edit could silently fall through.
 */
sealed class Landmark {
  data class Present(val point: Point2D, val confidence: Double) : Landmark()
  object Absent : Landmark()
}

/**
 * Raw wire shape for JSON decoding — kotlinx.serialization does not decode
 * directly into a sealed class from this JSON shape without a custom
 * serializer, which has not been written or tested in this session (no
 * Kotlin compiler available to verify it). `toLandmark()` below is the
 * TODO boundary: convert once decoding is verified against a real fixture
 * on a real toolchain.
 */
@Serializable
data class LandmarkWire(val present: Boolean, val point: Point2D? = null, val confidence: Double? = null) {
  fun toLandmark(): Landmark =
    if (present && point != null && confidence != null) Landmark.Present(point, confidence) else Landmark.Absent
}

@Serializable
data class BodyFrameWire(
  val timestamp: Double,
  val headCenter: LandmarkWire,
  val noseOrHeadDirection: LandmarkWire,
  val neckCenter: LandmarkWire,
  val leftShoulder: LandmarkWire,
  val rightShoulder: LandmarkWire,
  val leftElbow: LandmarkWire,
  val rightElbow: LandmarkWire,
  val leftWrist: LandmarkWire,
  val rightWrist: LandmarkWire,
  val chestCenter: LandmarkWire,
  val waistCenter: LandmarkWire,
  val leftHip: LandmarkWire,
  val rightHip: LandmarkWire,
  val torsoCenter: LandmarkWire,
  val torsoWidth: Double? = null,
  val torsoHeight: Double? = null,
  val torsoRotation: Double? = null,
  val trackingConfidence: Double,
)

data class BodyFrame(
  val timestamp: Double,
  val headCenter: Landmark,
  val noseOrHeadDirection: Landmark,
  val neckCenter: Landmark,
  val leftShoulder: Landmark,
  val rightShoulder: Landmark,
  val leftElbow: Landmark,
  val rightElbow: Landmark,
  val leftWrist: Landmark,
  val rightWrist: Landmark,
  val chestCenter: Landmark,
  val waistCenter: Landmark,
  val leftHip: Landmark,
  val rightHip: Landmark,
  val torsoCenter: Landmark,
  val torsoWidth: Double?,
  val torsoHeight: Double?,
  val torsoRotation: Double?,
  val trackingConfidence: Double,
) {
  companion object {
    fun from(wire: BodyFrameWire): BodyFrame = BodyFrame(
      timestamp = wire.timestamp,
      headCenter = wire.headCenter.toLandmark(),
      noseOrHeadDirection = wire.noseOrHeadDirection.toLandmark(),
      neckCenter = wire.neckCenter.toLandmark(),
      leftShoulder = wire.leftShoulder.toLandmark(),
      rightShoulder = wire.rightShoulder.toLandmark(),
      leftElbow = wire.leftElbow.toLandmark(),
      rightElbow = wire.rightElbow.toLandmark(),
      leftWrist = wire.leftWrist.toLandmark(),
      rightWrist = wire.rightWrist.toLandmark(),
      chestCenter = wire.chestCenter.toLandmark(),
      waistCenter = wire.waistCenter.toLandmark(),
      leftHip = wire.leftHip.toLandmark(),
      rightHip = wire.rightHip.toLandmark(),
      torsoCenter = wire.torsoCenter.toLandmark(),
      torsoWidth = wire.torsoWidth,
      torsoHeight = wire.torsoHeight,
      torsoRotation = wire.torsoRotation,
      trackingConfidence = wire.trackingConfidence,
    )
  }
}

// ─── Perception provider ─────────────────────────────────────────────────────

/** Mirrors ios/LiveVTOPerceptionProvider.swift's PerceptionProvider protocol. */
interface PerceptionProvider {
  val frameSource: FrameSource
  fun start(onFrame: (BodyFrame) -> Unit, onError: (Throwable) -> Unit)
  fun stop()
}

/**
 * TODO(P1-B2): wraps a MediaPipe Pose Landmarker Task build (Android has no
 * first-party equivalent to iOS Vision's body-pose API — see
 * docs/vto-native-device-handoff.md Section 2). Requires EMULATOR_CAMERA;
 * SIMULATOR_CAMERA is an iOS-only concept and must never be passed here.
 */
class RealLocalPoseProvider(override val frameSource: FrameSource) : PerceptionProvider {
  init {
    require(frameSource == FrameSource.EMULATOR_CAMERA) {
      "RealLocalPoseProvider on Android requires EMULATOR_CAMERA, got $frameSource"
    }
  }

  override fun start(onFrame: (BodyFrame) -> Unit, onError: (Throwable) -> Unit) {
    // TODO: not implemented. No pose runtime integrated or run in this
    // session — see the matching TODO in the Swift file.
    error("RealLocalPoseProvider.start is not implemented — see docs/vto-native-device-handoff.md Section 2")
  }

  override fun stop() {}
}

class NativeReplayFixtureException(message: String) : Exception(message)

/**
 * Consumes the JSON fixture format from
 * packages/evaluation/src/nativeReplayFixture.ts entirely on the native
 * side — see the Swift file's matching type for the full rationale. Never
 * compiled or run; kotlinx.serialization's actual decoding behavior against
 * a real fixture has not been verified.
 */
class NativeReplayPerceptionProvider(private val fixtureJson: String) : PerceptionProvider {
  override val frameSource: FrameSource = FrameSource.NATIVE_REPLAY_FIXTURE
  private var isRunning = false

  @Serializable
  private data class Manifest(val frameSource: String)

  @Serializable
  private data class Fixture(val manifest: Manifest, val frames: List<BodyFrameWire>)

  override fun start(onFrame: (BodyFrame) -> Unit, onError: (Throwable) -> Unit) {
    isRunning = true
    try {
      val fixture = Json.decodeFromString(Fixture.serializer(), fixtureJson)
      if (fixture.manifest.frameSource != FrameSource.NATIVE_REPLAY_FIXTURE.wireValue) {
        onError(NativeReplayFixtureException("expected NATIVE_REPLAY_FIXTURE, got ${fixture.manifest.frameSource}"))
        return
      }
      // TODO: real replay would pace emission against each frame's
      // timestamp rather than emitting synchronously — not implemented.
      for (wire in fixture.frames) {
        if (!isRunning) break
        onFrame(BodyFrame.from(wire))
      }
    } catch (e: Exception) {
      onError(NativeReplayFixtureException(e.message ?: "malformed native replay fixture"))
    }
  }

  override fun stop() {
    isRunning = false
  }
}
