package expo.modules.kscanlivevtonative

import org.json.JSONObject

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
    fun parse(json: JSONObject): KsgarmentManifest {
      val version = json.getString("version")
      if (version != KSGARMENT_SCHEMA_VERSION) {
        throw LiveVtoGarmentValidationException("unsupported ksgarment schema version: $version")
      }
      val controlPointsJson = json.getJSONArray("controlPoints")
      val controlPoints = mutableListOf<GarmentControlPoint>()
      for (i in 0 until controlPointsJson.length()) {
        val cp = controlPointsJson.getJSONObject(i)
        val id = GarmentControlPointId.fromId(cp.getString("id")) ?: continue
        controlPoints.add(GarmentControlPoint(id, cp.getDouble("u").toFloat(), cp.getDouble("v").toFloat()))
      }
      val presentIds = controlPoints.map { it.id }.toSet()
      val missing = MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT - presentIds
      if (missing.isNotEmpty()) {
        throw LiveVtoGarmentValidationException(
          "manifest missing required control points: ${missing.joinToString { it.id }}"
        )
      }
      val meshJson = json.getJSONObject("meshDefinition")
      if (meshJson.getString("type") != "grid") {
        throw LiveVtoGarmentValidationException("unsupported meshDefinition.type: ${meshJson.getString("type")}")
      }
      return KsgarmentManifest(
        version = version,
        productId = json.getString("productId"),
        category = json.getString("category"),
        controlPoints = controlPoints,
        meshDefinition = MeshDefinition(meshJson.getInt("width"), meshJson.getInt("height")),
        texture = json.getString("texture"),
        alphaMask = json.getString("alphaMask"),
        assetVersion = json.getString("assetVersion"),
      )
    }
  }
}

class LiveVtoGarmentValidationException(message: String) : Exception(message)
