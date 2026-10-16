package expo.modules.kscanlivevtonative

import java.io.File

/**
 * Loader for the persisted golden BodyFrame set
 * (`modules/kscan-live-vto-native/goldens/bodyframes.json`).
 *
 * The goldens live in a committed JSON file rather than inside Kotlin test
 * methods (amendment D12) for one reason that matters: the SAME file is read
 * by the Node reference-oracle runner (`tools/run-reference-oracle.mjs`).
 * If the cases lived in Kotlin, the two runtimes would be compared on two
 * separately-typed copies of "the same" pose, and the first typo would look
 * like a conformance divergence.
 */
data class GoldenCase(
  val id: String,
  val note: String,
  val expectedFailure: String?,
  val expectedGateFindings: List<String>,
  val frame: BodyFrame,
)

object GoldenBodyFrames {

  /** Walks up from the test working directory to the module root. */
  fun moduleRoot(): File {
    var dir = File(".").absoluteFile
    while (dir.parentFile != null) {
      if (File(dir, "goldens/bodyframes.json").isFile) return dir
      dir = dir.parentFile
    }
    throw IllegalStateException("could not locate module root containing goldens/bodyframes.json from ${File(".").absolutePath}")
  }

  fun load(): Pair<List<GoldenCase>, List<GoldenCase>> {
    val root = moduleRoot()
    val doc = LiveVtoJson.obj(LiveVtoJson.parse(File(root, "goldens/bodyframes.json").readText()))
    val valid = LiveVtoJson.arr(doc["cases"]).map { toCase(it, false) }
    val refusals = LiveVtoJson.arr(doc["refusalCases"]).map { toCase(it, true) }
    return Pair(valid, refusals)
  }

  private fun toCase(entry: Any?, isRefusal: Boolean): GoldenCase {
    val o = LiveVtoJson.obj(entry)
    val expectedFailure = if (isRefusal) o["expectedFailure"] as? String else null
    val expectedGateFindings = (o["expectedGateFindings"] as? List<*>)?.map { it as String } ?: emptyList()
    val landmarks = LiveVtoJson.obj(o["landmarks"])
    fun mark(name: String): Landmark {
      val raw = landmarks[name] ?: return Landmark.Absent
      val pair = LiveVtoJson.arr(raw)
      return Landmark.Present(Vec2(coord(pair[0]), coord(pair[1])), 1f)
    }
    return GoldenCase(
      id = LiveVtoJson.str(o["id"]),
      note = LiveVtoJson.str(o["note"]),
      expectedFailure = expectedFailure,
      expectedGateFindings = expectedGateFindings,
      frame = BodyFrame(
        timestampMs = 0L,
        headCenter = mark("headCenter"),
        noseOrHeadDirection = Landmark.Absent,
        neckCenter = mark("neckCenter"),
        leftShoulder = mark("leftShoulder"),
        rightShoulder = mark("rightShoulder"),
        leftElbow = mark("leftElbow"),
        rightElbow = mark("rightElbow"),
        leftWrist = mark("leftWrist"),
        rightWrist = mark("rightWrist"),
        chestCenter = Landmark.Absent,
        waistCenter = Landmark.Absent,
        leftHip = mark("leftHip"),
        rightHip = mark("rightHip"),
        torsoCenter = Landmark.Absent,
        torsoWidth = null,
        torsoHeight = null,
        torsoRotation = null,
        trackingConfidence = 1f,
      ),
    )
  }

  /**
   * JSON has no literal for NaN/Infinity, so the golden file encodes them as
   * strings (declared in its own `nonFiniteEncoding` field). Decoding them
   * here is the only way the finite-ness guards can be tested at all -- a
   * golden set that could not express a NaN could not prove a NaN is
   * rejected.
   */
  private fun coord(v: Any?): Float = when (v) {
    is Double -> v.toFloat()
    "NaN" -> Float.NaN
    "Infinity" -> Float.POSITIVE_INFINITY
    "-Infinity" -> Float.NEGATIVE_INFINITY
    else -> throw IllegalArgumentException("unsupported coordinate encoding: $v")
  }

  fun fixture(name: String): Pair<KsgarmentManifest, Pair<Int, Int>> {
    val dir = File(moduleRoot(), "android/src/main/assets/$name")
    val manifest = KsgarmentManifest.parseAssetManifest(File(dir, "manifest.json").readText())
    val dims = pngDimensions(File(dir, manifest.texture))
    return Pair(manifest, dims)
  }

  /** Reads width/height straight out of a PNG IHDR -- no Android BitmapFactory in a JVM test. */
  private fun pngDimensions(file: File): Pair<Int, Int> {
    val bytes = file.readBytes()
    require(bytes.size > 24 && bytes[1] == 'P'.code.toByte()) { "not a PNG: $file" }
    fun be(at: Int) = ((bytes[at].toInt() and 0xff) shl 24) or ((bytes[at + 1].toInt() and 0xff) shl 16) or
      ((bytes[at + 2].toInt() and 0xff) shl 8) or (bytes[at + 3].toInt() and 0xff)
    return Pair(be(16), be(20))
  }
}
