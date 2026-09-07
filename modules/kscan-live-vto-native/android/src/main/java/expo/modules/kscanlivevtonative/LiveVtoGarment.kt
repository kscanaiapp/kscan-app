package expo.modules.kscanlivevtonative


/**
 * Native re-declaration of the .ksgarment contract -- same field set as
 * kscan-live-vto/packages/garment-contract/src/ksgarment.ts (PR #295) and
 * this app's own vto-phase4-pipeline/src/garmentContract.ts, both read via
 * `git show` (research package) / direct read (Phase 4 pipeline, already in
 * this worktree). Re-declared, not imported, for the same reason as
 * LiveVtoBodyFrame.kt.
 */
enum class GarmentControlPointId(val id: String) {
  LEFT_SHOULDER("leftShoulder"),
  RIGHT_SHOULDER("rightShoulder"),
  LEFT_ARMPIT("leftArmpit"),
  RIGHT_ARMPIT("rightArmpit"),
  LEFT_TORSO("leftTorso"),
  RIGHT_TORSO("rightTorso"),
  WAIST("waist"),
  LEFT_HEM("leftHem"),
  RIGHT_HEM("rightHem"),
  LEFT_SLEEVE("leftSleeve"),
  RIGHT_SLEEVE("rightSleeve");

  companion object {
    fun fromId(id: String): GarmentControlPointId? = values().find { it.id == id }
  }
}

val MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT = setOf(
  GarmentControlPointId.LEFT_SHOULDER,
  GarmentControlPointId.RIGHT_SHOULDER,
  GarmentControlPointId.LEFT_HEM,
  GarmentControlPointId.RIGHT_HEM,
)

/** Texture-space [0,1] control point, as authored on the garment asset. */
data class GarmentControlPoint(val id: GarmentControlPointId, val u: Float, val v: Float)

data class MeshDefinition(val width: Int, val height: Int)

const val KSGARMENT_SCHEMA_VERSION = "1.0"

data class KsgarmentManifest(
  val version: String,
  val productId: String,
  val category: String,
  val controlPoints: List<GarmentControlPoint>,
  val meshDefinition: MeshDefinition,
  val texture: String,
  val alphaMask: String,
  val assetVersion: String,
) {
  fun controlPoint(id: GarmentControlPointId): GarmentControlPoint? =
    controlPoints.find { it.id == id }

  companion object {
    /**
     * Structural validation only -- mirrors validateKsgarmentManifest's
     * intent (both research and Phase-4 copies): reject a manifest missing
     * the P1-E1 minimum control points, an unsupported schema version, or a
     * non-grid mesh, rather than rendering a partial/wrong garment.
     */
    fun parse(json: Map<String, Any?>): KsgarmentManifest {
      val version = LiveVtoJson.str(json["version"])
      if (version != KSGARMENT_SCHEMA_VERSION) {
        throw LiveVtoGarmentValidationException("unsupported ksgarment schema version: $version")
      }
      val controlPoints = mutableListOf<GarmentControlPoint>()
      for (entry in LiveVtoJson.arr(json["controlPoints"])) {
        val cp = LiveVtoJson.obj(entry)
        val id = GarmentControlPointId.fromId(LiveVtoJson.str(cp["id"])) ?: continue
        val u = LiveVtoJson.num(cp["u"]).toFloat()
        val v = LiveVtoJson.num(cp["v"]).toFloat()
        if (!u.isFinite() || !v.isFinite()) {
          throw LiveVtoGarmentValidationException("non-finite control point coordinate: ${id.id}")
        }
        controlPoints.add(GarmentControlPoint(id, u, v))
      }
      val presentIds = controlPoints.map { it.id }.toSet()
      val missing = MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT - presentIds
      if (missing.isNotEmpty()) {
        throw LiveVtoGarmentValidationException(
          "manifest missing required control points: ${missing.joinToString { it.id }}"
        )
      }
      val mesh = LiveVtoJson.obj(json["meshDefinition"])
      val meshType = LiveVtoJson.str(mesh["type"])
      if (meshType != "grid") {
        throw LiveVtoGarmentValidationException("unsupported meshDefinition.type: $meshType")
      }
      val meshWidth = LiveVtoJson.num(mesh["width"]).toInt()
      val meshHeight = LiveVtoJson.num(mesh["height"]).toInt()
      // width/height are VERTEX counts (the reference divides by count-1),
      // so a grid needs at least 2 in each axis to define a single cell.
      if (meshWidth < 2 || meshHeight < 2) {
        throw LiveVtoGarmentValidationException("degenerate meshDefinition: ${meshWidth}x${meshHeight} vertices")
      }
      return KsgarmentManifest(
        version = version,
        productId = LiveVtoJson.str(json["productId"]),
        category = LiveVtoJson.str(json["category"]),
        controlPoints = controlPoints,
        meshDefinition = MeshDefinition(meshWidth, meshHeight),
        texture = LiveVtoJson.str(json["texture"]),
        alphaMask = LiveVtoJson.str(json["alphaMask"]),
        assetVersion = LiveVtoJson.str(json["assetVersion"]),
      )
    }

    /** Reads the full generated-asset manifest and returns its `ksgarment` block. */
    fun parseAssetManifest(text: String): KsgarmentManifest =
      parse(LiveVtoJson.obj(LiveVtoJson.obj(LiveVtoJson.parse(text))["ksgarment"]))
  }
}

class LiveVtoGarmentValidationException(message: String) : Exception(message)
