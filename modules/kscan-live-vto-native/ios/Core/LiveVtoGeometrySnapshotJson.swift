import Foundation

/// Deterministic JSON serialization of a `GeometrySnapshot`.
///
/// Hand-rolled rather than `JSONSerialization`/`JSONEncoder` on purpose --
/// field-for-field port of Android's `LiveVtoGeometrySnapshotJson.kt`, whose
/// own header explains why a hand-rolled serializer is required there
/// (`org.json` is stubbed in JVM unit tests). That specific reason does not
/// apply on iOS (`JSONSerialization` works identically in `swift test` and in
/// the real app), but the OUTPUT FORMAT is kept byte-for-byte compatible with
/// Android's on purpose: fixed key order, full-precision floats, sorted
/// control-point keys -- so the two platforms' diagnostic snapshots (and any
/// future cross-platform diff tooling) are directly comparable without a
/// normalization step.
public enum GeometrySnapshotJson {

  public static func encode(_ s: GeometrySnapshot, includeMesh: Bool = false) -> String {
    var b = "{"
    b += str("fixtureId", s.fixtureId) + ","
    b += str("bodyFrameId", s.bodyFrameId) + ","
    b += str("activeAssetId", s.activeAssetId) + ","
    b += str("assetVersion", s.assetVersion) + ","
    b += "\"failure\":" + (s.failure.map(quote) ?? "null") + ","
    b += "\"gatePassed\":\(s.gatePassed),"
    b += "\"gateFindings\":[" + s.gateFindings.map(quote).joined(separator: ",") + "],"
    b += num("scale", s.scale) + ","
    b += num("rotationRadians", s.rotationRadians) + ","
    b += "\"controlPoints\":{"
    // sorted for determinism -- dictionary iteration order must not leak into evidence
    b += s.controlPoints.sorted { $0.key < $1.key }
      .map { "\(quote($0.key)):[\(fmt($0.value.x)),\(fmt($0.value.y))]" }
      .joined(separator: ",")
    b += "},"
    b += "\"bounds\":{"
    b += num("minX", s.boundsMin.x) + ","
    b += num("minY", s.boundsMin.y) + ","
    b += num("maxX", s.boundsMax.x) + ","
    b += num("maxY", s.boundsMax.y) + "},"
    b += num("canvasWidth", s.canvasWidth) + ","
    b += num("canvasHeight", s.canvasHeight) + ","
    b += "\"textureWidth\":\(s.textureWidth),"
    b += "\"textureHeight\":\(s.textureHeight),"
    b += "\"meshWidth\":\(s.meshWidth),"
    b += "\"meshHeight\":\(s.meshHeight),"
    b += "\"meshVertexCount\":\((s.meshVertices?.count ?? 0) / 2),"
    b += "\"validationProblems\":[" + s.validate().map(quote).joined(separator: ",") + "]"
    if includeMesh, let meshVertices = s.meshVertices {
      b += ",\"meshVertices\":[" + meshVertices.map(fmt).joined(separator: ",") + "]"
    }
    b += "}"
    return b
  }

  private static func fmt(_ f: Float) -> String { f.isFinite ? formatFloat(f) : "\"\(f)\"" }

  /// Swift's default `Float` string conversion and Kotlin's `Float.toString()`
  /// use different (but both round-trippable) formatting rules; this matters
  /// only for byte-identical diffing across platforms, never for the numeric
  /// value a test actually compares. Emits the shortest round-trippable
  /// decimal, matching `Double`'s well-defined `description` semantics.
  private static func formatFloat(_ f: Float) -> String {
    if f == f.rounded() && abs(f) < 1e15 {
      return String(format: "%.1f", f)
    }
    return "\(f)"
  }

  private static func quote(_ v: String) -> String {
    "\"" + v.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
  }
  private static func str(_ k: String, _ v: String) -> String { "\(quote(k)):\(quote(v))" }
  private static func num(_ k: String, _ v: Float) -> String { "\(quote(k)):\(fmt(v))" }
}

/// Short one-line form for logging -- never carries mesh vertices.
public func describeSnapshot(_ s: GeometrySnapshot) -> String {
  GeometrySnapshotJson.encode(s, includeMesh: false)
}
