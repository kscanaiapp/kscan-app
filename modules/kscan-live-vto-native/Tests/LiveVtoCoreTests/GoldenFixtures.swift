import Foundation
@testable import LiveVtoCore

/// Shared loader for the ONE canonical `goldens/bodyframes.json` -- the same
/// file `tools/run-reference-oracle.mjs` and Android's `GoldenBodyFrames.kt`
/// both read, so a typo cannot masquerade as a conformance divergence between
/// platforms. Loaded via `#filePath`-relative resolution rather than an
/// SwiftPM `resources:` copy so this stays the single tracked file, never a
/// duplicate that could drift from it.
enum GoldenFixtures {
  /// Walks up from this very source file (`Tests/LiveVtoCoreTests/GoldenFixtures.swift`)
  /// to the module root (`modules/kscan-live-vto-native/`), which is stable
  /// as long as this file itself is not moved.
  static var moduleRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // GoldenFixtures.swift -> LiveVtoCoreTests/
      .deletingLastPathComponent() // -> Tests/
      .deletingLastPathComponent() // -> module root
  }

  struct RawCase {
    let id: String
    let note: String?
    let landmarks: [String: [Any]]
    let expectedFailure: String?
    let expectedGateFindings: [String]?
  }

  struct GoldenSet {
    let renderCanvasWidth: Float
    let renderCanvasHeight: Float
    let cases: [RawCase]
    let refusalCases: [RawCase]
  }

  static func loadBodyFrames() throws -> GoldenSet {
    let url = moduleRoot.appendingPathComponent("goldens/bodyframes.json")
    let data = try Data(contentsOf: url)
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw LiveVtoGarmentValidationError("bodyframes.json is not a JSON object")
    }
    let canvas = root["renderCanvas"] as? [String: Any]
    let width = (canvas?["width"] as? NSNumber)?.floatValue ?? 720
    let height = (canvas?["height"] as? NSNumber)?.floatValue ?? 960

    func parseCases(_ key: String) -> [RawCase] {
      ((root[key] as? [[String: Any]]) ?? []).map { entry in
        RawCase(
          id: entry["id"] as? String ?? "",
          note: entry["note"] as? String,
          landmarks: (entry["landmarks"] as? [String: [Any]]) ?? [:],
          expectedFailure: entry["expectedFailure"] as? String,
          expectedGateFindings: entry["expectedGateFindings"] as? [String])
      }
    }

    return GoldenSet(renderCanvasWidth: width, renderCanvasHeight: height, cases: parseCases("cases"), refusalCases: parseCases("refusalCases"))
  }

  /// Golden landmark encoding (a 2-element [u,v] array, or JSON `null` for
  /// absent, with "NaN"/"Infinity"/"-Infinity" strings where JSON has no
  /// literal) -> the Core package's own `Landmark`. Mirrors
  /// `run-reference-oracle.mjs`'s `toLandmark` and Android's
  /// `GoldenBodyFrames.kt` decoding exactly.
  static func decodeLandmark(_ raw: [Any]?) -> Landmark {
    guard let raw = raw, raw.count == 2 else { return .absent }
    func decode(_ v: Any) -> Float {
      if let n = v as? NSNumber { return n.floatValue }
      if let s = v as? String {
        switch s {
        case "NaN": return .nan
        case "Infinity": return .infinity
        case "-Infinity": return -.infinity
        default: return .nan
        }
      }
      return .nan
    }
    return .present(point: Vec2(decode(raw[0]), decode(raw[1])), confidence: 1)
  }

  /// A `RawCase`'s landmarks -> a full `BodyFrame`, matching
  /// `run-reference-oracle.mjs`'s `toBodyFrame`: only the 10 raw landmark
  /// keys the goldens carry are populated; every derived field
  /// (chestCenter/waistCenter/torsoCenter/torsoWidth/torsoHeight/torsoRotation)
  /// is left absent/nil, since the geometry pipeline never consumes them.
  static func bodyFrame(_ c: RawCase) -> BodyFrame {
    BodyFrame(
      timestampMs: 0,
      headCenter: decodeLandmark(c.landmarks["headCenter"]),
      noseOrHeadDirection: .absent,
      neckCenter: decodeLandmark(c.landmarks["neckCenter"]),
      leftShoulder: decodeLandmark(c.landmarks["leftShoulder"]),
      rightShoulder: decodeLandmark(c.landmarks["rightShoulder"]),
      leftElbow: decodeLandmark(c.landmarks["leftElbow"]),
      rightElbow: decodeLandmark(c.landmarks["rightElbow"]),
      leftWrist: decodeLandmark(c.landmarks["leftWrist"]),
      rightWrist: decodeLandmark(c.landmarks["rightWrist"]),
      chestCenter: .absent,
      waistCenter: .absent,
      leftHip: decodeLandmark(c.landmarks["leftHip"]),
      rightHip: decodeLandmark(c.landmarks["rightHip"]),
      torsoCenter: .absent,
      torsoWidth: nil,
      torsoHeight: nil,
      torsoRotation: nil,
      trackingConfidence: 1)
  }

  // MARK: - Governed fixture manifests (n1b-fixture, n1c-asym-fixture)

  static func loadManifest(fixture: String) throws -> (manifest: KsgarmentManifest, textureWidth: Int, textureHeight: Int) {
    let dir = moduleRoot.appendingPathComponent("android/src/main/assets/\(fixture)")
    let manifestText = try String(contentsOf: dir.appendingPathComponent("manifest.json"), encoding: .utf8)
    let manifest = try KsgarmentManifest.parseAssetManifest(manifestText)
    let (w, h) = try pngDimensions(dir.appendingPathComponent(manifest.texture))
    return (manifest, w, h)
  }

  /// Reads a PNG's IHDR chunk directly -- no image-decoding dependency needed,
  /// only dimensions, matching `run-reference-oracle.mjs`'s own
  /// `pngDimensions` helper exactly so both tools agree on texture size
  /// without either decoding pixels.
  static func pngDimensions(_ url: URL) throws -> (Int, Int) {
    let data = try Data(contentsOf: url)
    guard data.count >= 24 else { throw LiveVtoGarmentValidationError("PNG too short: \(url.path)") }
    func be32(_ offset: Int) -> Int {
      Int(data[offset]) << 24 | Int(data[offset + 1]) << 16 | Int(data[offset + 2]) << 8 | Int(data[offset + 3])
    }
    return (be32(16), be32(20))
  }

  // MARK: - Committed reference-oracle snapshots (goldens/reference-snapshots.jsonl)

  struct ReferenceSnapshot {
    let fixture: String
    let caseId: String
    let textureWidth: Int
    let textureHeight: Int
    let failure: String?
    let gatePassed: Bool?
    let gateFindings: [String]?
    let scale: Float?
    let rotationRadians: Float?
    let controlPoints: [String: Vec2]?
    let meshVertices: [Float]?
    let meshColumns: Int?
    let meshRows: Int?
  }

  /// Loads `goldens/reference-snapshots.jsonl`, generated by running
  /// `tools/run-reference-oracle.mjs` against the P3-A reference oracle
  /// checkout locally and committing the output -- see
  /// `goldens/reference-provenance.json` for the exact reference SHA and
  /// `docs/vto-live-bridge-contract.md` for how/when to regenerate it.
  static func loadReferenceSnapshots() throws -> [ReferenceSnapshot] {
    let url = moduleRoot.appendingPathComponent("goldens/reference-snapshots.jsonl")
    let text = try String(contentsOf: url, encoding: .utf8)
    var out: [ReferenceSnapshot] = []
    for line in text.split(separator: "\n") {
      guard let data = line.data(using: .utf8),
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let snapshot = obj["snapshot"] as? [String: Any]
      else { continue }

      var controlPoints: [String: Vec2]?
      if let cp = snapshot["controlPoints"] as? [String: [Any]] {
        var m: [String: Vec2] = [:]
        for (k, v) in cp where v.count == 2 {
          m[k] = Vec2((v[0] as? NSNumber)?.floatValue ?? .nan, (v[1] as? NSNumber)?.floatValue ?? .nan)
        }
        controlPoints = m
      }
      var meshVertices: [Float]?
      var meshColumns: Int?
      var meshRows: Int?
      if let mesh = snapshot["mesh"] as? [String: Any] {
        meshColumns = (mesh["columns"] as? NSNumber)?.intValue
        meshRows = (mesh["rows"] as? NSNumber)?.intValue
        meshVertices = (mesh["vertices"] as? [NSNumber])?.map(\.floatValue)
      }

      out.append(ReferenceSnapshot(
        fixture: obj["fixture"] as? String ?? "",
        caseId: obj["case"] as? String ?? "",
        textureWidth: (obj["textureWidth"] as? NSNumber)?.intValue ?? 0,
        textureHeight: (obj["textureHeight"] as? NSNumber)?.intValue ?? 0,
        failure: snapshot["failure"] as? String,
        gatePassed: snapshot["gatePassed"] as? Bool,
        gateFindings: snapshot["gateFindings"] as? [String],
        scale: (snapshot["scale"] as? NSNumber)?.floatValue,
        rotationRadians: (snapshot["rotationRadians"] as? NSNumber)?.floatValue,
        controlPoints: controlPoints,
        meshVertices: meshVertices,
        meshColumns: meshColumns,
        meshRows: meshRows))
    }
    return out
  }
}
