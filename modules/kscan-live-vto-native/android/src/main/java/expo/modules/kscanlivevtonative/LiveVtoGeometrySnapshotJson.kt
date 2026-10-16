package expo.modules.kscanlivevtonative

/**
 * Deterministic JSON serialization of a GeometrySnapshot.
 *
 * Hand-rolled rather than org.json on purpose: `org.json` is an Android
 * framework class stubbed out in JVM unit tests, and this serializer has to
 * run in exactly the two places conformance depends on -- the JVM
 * conformance test that writes the native side of the delta table, and the
 * on-device diagnostic that proves the device computes the same numbers.
 * A serializer that only worked in one of them would leave the other's
 * evidence unverifiable.
 *
 * Key order is fixed and floats are emitted at full precision, so two runs
 * of the same input produce byte-identical output and the evidence files
 * diff cleanly.
 */
object GeometrySnapshotJson {

  fun encode(s: GeometrySnapshot, includeMesh: Boolean = false): String {
    val b = StringBuilder(1024)
    b.append('{')
    b.str("fixtureId", s.fixtureId).append(',')
    b.str("bodyFrameId", s.bodyFrameId).append(',')
    b.str("activeAssetId", s.activeAssetId).append(',')
    b.str("assetVersion", s.assetVersion).append(',')
    b.append("\"failure\":").append(s.failure?.let { quote(it) } ?: "null").append(',')
    b.append("\"gatePassed\":").append(s.gatePassed).append(',')
    b.append("\"gateFindings\":[").append(s.gateFindings.joinToString(",") { quote(it) }).append("],")
    b.num("scale", s.scale).append(',')
    b.num("rotationRadians", s.rotationRadians).append(',')
    b.append("\"controlPoints\":{")
    // sorted for determinism -- map iteration order must not leak into evidence
    b.append(s.controlPoints.entries.sortedBy { it.key }.joinToString(",") { (k, v) ->
      "${quote(k)}:[${fmt(v.x)},${fmt(v.y)}]"
    })
    b.append("},")
    b.append("\"bounds\":{")
      .num("minX", s.boundsMin.x).append(',')
      .num("minY", s.boundsMin.y).append(',')
      .num("maxX", s.boundsMax.x).append(',')
      .num("maxY", s.boundsMax.y).append("},")
    b.num("canvasWidth", s.canvasWidth).append(',')
    b.num("canvasHeight", s.canvasHeight).append(',')
    b.append("\"textureWidth\":").append(s.textureWidth).append(',')
    b.append("\"textureHeight\":").append(s.textureHeight).append(',')
    b.append("\"meshWidth\":").append(s.meshWidth).append(',')
    b.append("\"meshHeight\":").append(s.meshHeight).append(',')
    b.append("\"meshVertexCount\":").append(s.meshVertices?.size?.div(2) ?: 0).append(',')
    b.append("\"validationProblems\":[").append(s.validate().joinToString(",") { quote(it) }).append(']')
    if (includeMesh && s.meshVertices != null) {
      b.append(",\"meshVertices\":[").append(s.meshVertices.joinToString(",") { fmt(it) }).append(']')
    }
    b.append('}')
    return b.toString()
  }

  private fun fmt(f: Float): String = if (f.isFinite()) f.toString() else "\"$f\""
  private fun quote(v: String): String = "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
  private fun StringBuilder.str(k: String, v: String) = append(quote(k)).append(':').append(quote(v))
  private fun StringBuilder.num(k: String, v: Float) = append(quote(k)).append(':').append(fmt(v))
}

/** Short one-line form for logcat -- never carries mesh vertices. */
fun describeSnapshot(s: GeometrySnapshot): String = GeometrySnapshotJson.encode(s, includeMesh = false)
