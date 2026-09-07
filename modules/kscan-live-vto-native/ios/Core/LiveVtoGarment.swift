import Foundation

/// Native re-declaration of the .ksgarment contract -- same field set as
/// `kscan-live-vto/packages/garment-contract/src/ksgarment.ts` (PR #295) and
/// Android's own re-declaration in `LiveVtoGarment.kt`. Re-declared, not
/// imported, for the same reason as `LiveVtoBodyFrame.swift`: the research
/// package is a disjoint, unmerged git history.
public enum GarmentControlPointId: String, CaseIterable, Codable, Comparable {
  case leftShoulder, rightShoulder
  case leftArmpit, rightArmpit
  case leftTorso, rightTorso
  case waist
  case leftHem, rightHem
  case leftSleeve, rightSleeve

  public static func < (a: GarmentControlPointId, b: GarmentControlPointId) -> Bool {
    a.rawValue < b.rawValue
  }
}

public let MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT: Set<GarmentControlPointId> = [
  .leftShoulder, .rightShoulder, .leftHem, .rightHem,
]

/// Texture-space [0,1] control point, as authored on the garment asset.
public struct GarmentControlPoint: Equatable {
  public let id: GarmentControlPointId
  public let u: Float
  public let v: Float

  public init(id: GarmentControlPointId, u: Float, v: Float) {
    self.id = id
    self.u = u
    self.v = v
  }
}

public struct MeshDefinition: Equatable {
  /// VERTEX counts, not cell counts -- the reference divides by count-1. See
  /// `LiveVtoDeformation.gridSourceVertices`.
  public let width: Int
  public let height: Int

  public init(width: Int, height: Int) {
    self.width = width
    self.height = height
  }
}

public let KSGARMENT_SCHEMA_VERSION = "1.0"

public struct LiveVtoGarmentValidationError: Error, CustomStringConvertible {
  public let message: String
  public init(_ message: String) { self.message = message }
  public var description: String { message }
}

public struct KsgarmentManifest: Equatable {
  public let version: String
  public let productId: String
  public let category: String
  public let controlPoints: [GarmentControlPoint]
  public let meshDefinition: MeshDefinition
  public let texture: String
  public let alphaMask: String
  public let assetVersion: String

  public init(
    version: String, productId: String, category: String, controlPoints: [GarmentControlPoint],
    meshDefinition: MeshDefinition, texture: String, alphaMask: String, assetVersion: String
  ) {
    self.version = version
    self.productId = productId
    self.category = category
    self.controlPoints = controlPoints
    self.meshDefinition = meshDefinition
    self.texture = texture
    self.alphaMask = alphaMask
    self.assetVersion = assetVersion
  }

  public func controlPoint(_ id: GarmentControlPointId) -> GarmentControlPoint? {
    controlPoints.first { $0.id == id }
  }

  /// Structural validation only -- mirrors `validateKsgarmentManifest`'s intent
  /// (and Android's `KsgarmentManifest.parse`): reject a manifest missing the
  /// P1-E1 minimum control points, an unsupported schema version, or a
  /// non-grid mesh, rather than rendering a partial/wrong garment.
  public static func parse(_ json: [String: Any]) throws -> KsgarmentManifest {
    guard let version = json["version"] as? String, version == KSGARMENT_SCHEMA_VERSION else {
      throw LiveVtoGarmentValidationError("unsupported ksgarment schema version: \(String(describing: json["version"]))")
    }

    var controlPoints: [GarmentControlPoint] = []
    for entry in (json["controlPoints"] as? [[String: Any]]) ?? [] {
      guard let idString = entry["id"] as? String, let id = GarmentControlPointId(rawValue: idString) else { continue }
      guard let u = (entry["u"] as? NSNumber)?.floatValue, let v = (entry["v"] as? NSNumber)?.floatValue else {
        throw LiveVtoGarmentValidationError("missing control point coordinate: \(idString)")
      }
      guard u.isFinite, v.isFinite else {
        throw LiveVtoGarmentValidationError("non-finite control point coordinate: \(idString)")
      }
      controlPoints.append(GarmentControlPoint(id: id, u: u, v: v))
    }

    let presentIds = Set(controlPoints.map(\.id))
    let missing = MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT.subtracting(presentIds)
    if !missing.isEmpty {
      throw LiveVtoGarmentValidationError(
        "manifest missing required control points: \(missing.map(\.rawValue).sorted().joined(separator: ", "))")
    }

    guard let mesh = json["meshDefinition"] as? [String: Any] else {
      throw LiveVtoGarmentValidationError("meshDefinition required")
    }
    guard let meshType = mesh["type"] as? String, meshType == "grid" else {
      throw LiveVtoGarmentValidationError("unsupported meshDefinition.type: \(String(describing: mesh["type"]))")
    }
    guard let meshWidth = (mesh["width"] as? NSNumber)?.intValue,
          let meshHeight = (mesh["height"] as? NSNumber)?.intValue else {
      throw LiveVtoGarmentValidationError("meshDefinition width/height required")
    }
    // width/height are VERTEX counts (the reference divides by count-1), so a
    // grid needs at least 2 in each axis to define a single cell.
    if meshWidth < 2 || meshHeight < 2 {
      throw LiveVtoGarmentValidationError("degenerate meshDefinition: \(meshWidth)x\(meshHeight) vertices")
    }

    guard let productId = json["productId"] as? String,
          let category = json["category"] as? String,
          let texture = json["texture"] as? String,
          let alphaMask = json["alphaMask"] as? String,
          let assetVersion = json["assetVersion"] as? String else {
      throw LiveVtoGarmentValidationError("manifest missing a required string field")
    }

    return KsgarmentManifest(
      version: version, productId: productId, category: category, controlPoints: controlPoints,
      meshDefinition: MeshDefinition(width: meshWidth, height: meshHeight),
      texture: texture, alphaMask: alphaMask, assetVersion: assetVersion)
  }

  /// Reads the full generated-asset manifest and returns its `ksgarment` block.
  public static func parseAssetManifest(_ text: String) throws -> KsgarmentManifest {
    guard let data = text.data(using: .utf8),
          let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ksgarment = root["ksgarment"] as? [String: Any] else {
      throw LiveVtoGarmentValidationError("asset manifest missing ksgarment block")
    }
    return try parse(ksgarment)
  }
}
