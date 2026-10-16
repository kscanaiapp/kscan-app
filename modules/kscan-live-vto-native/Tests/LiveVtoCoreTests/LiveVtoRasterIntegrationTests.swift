#if canImport(CoreGraphics)
import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import LiveVtoCore
import LiveVtoRendering

/// Real Core Graphics pixels from controlled poses, not physical camera evidence.
final class LiveVtoRasterIntegrationTests: XCTestCase {
  func testBothTrianglesPreserveIdentityWarp() throws {
    func makeContext() throws -> CGContext {
      try XCTUnwrap(CGContext(data: nil, width: 40, height: 60, bitsPerComponent: 8, bytesPerRow: 160,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    }
    let source = try makeContext()
    source.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1)); source.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
    source.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1)); source.fill(CGRect(x: 0, y: 30, width: 40, height: 30))
    let image = try XCTUnwrap(source.makeImage())
    let expected = try makeContext()
    expected.draw(image, in: CGRect(x: 0, y: 0, width: 40, height: 60))
    let actual = try makeContext()
    LiveVtoRasterRenderer.drawMesh(actual, image: image, meshCellsWide: 1, meshCellsHigh: 1,
      verts: [0, 0, 40, 0, 0, 60, 40, 60], textureWidth: 40, textureHeight: 60)
    let wanted = try XCTUnwrap(expected.data).assumingMemoryBound(to: UInt8.self)
    let got = try XCTUnwrap(actual.data).assumingMemoryBound(to: UInt8.self)
    for (x, y) in [(5, 5), (35, 5), (5, 55), (35, 55)] {
      let offset = (y * 40 + x) * 4
      for channel in 0..<4 { XCTAssertEqual(got[offset + channel], wanted[offset + channel], "triangle warp changed identity") }
    }
    let empty = try makeContext()
    LiveVtoRasterRenderer.drawMesh(empty, image: image, meshCellsWide: 1, meshCellsHigh: 1,
      verts: [0, 0], textureWidth: 40, textureHeight: 60)
    XCTAssertEqual(Data(bytes: try XCTUnwrap(empty.data), count: 40 * 60 * 4), Data(repeating: 0, count: 40 * 60 * 4))
  }

  func testGovernedGarmentsProduceDistinctPixelsAndCaptureFiles() throws {
    let output = GoldenFixtures.moduleRoot.appendingPathComponent("build/render-evidence-ios")
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    var outputs = Set<Data>()
    for key in ["n1b-fixture", "n1c-asym-fixture", "ascolour-5001-black-v1"] {
      let dir = GoldenFixtures.moduleRoot.appendingPathComponent("ios/Assets/\(key)")
      for file in ["manifest.json", "texture.png", "alpha.png"] {
        var bytes = try Data(contentsOf: dir.appendingPathComponent(file))
        XCTAssertTrue(LiveVtoBundledAssetIntegrity.validate(key, file, bytes))
        bytes[0] ^= 1
        XCTAssertFalse(LiveVtoBundledAssetIntegrity.validate(key, file, bytes))
      }
      let source = try XCTUnwrap(CGImageSourceCreateWithURL(dir.appendingPathComponent("texture.png") as CFURL, nil))
      let texture = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
      let (manifest, w, h) = try GoldenFixtures.loadManifest(fixture: key)
      let snapshot = LiveVtoGeometryPipeline.compute(manifest: manifest, frame: .neutral(), bodyFrameId: "controlled-neutral",
        canvasWidth: 720, canvasHeight: 960, textureWidth: w, textureHeight: h)
      XCTAssertTrue(snapshot.gatePassed)
      let vertices = try XCTUnwrap(snapshot.meshVertices)
      let context = try XCTUnwrap(CGContext(data: nil, width: 720, height: 960, bitsPerComponent: 8, bytesPerRow: 720 * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      let empty = Data(bytes: try XCTUnwrap(context.data), count: 720 * 960 * 4)
      LiveVtoRasterRenderer.drawMesh(context, image: texture, meshCellsWide: snapshot.meshWidth, meshCellsHigh: snapshot.meshHeight,
        verts: vertices, textureWidth: w, textureHeight: h)
      let pixels = Data(bytes: try XCTUnwrap(context.data), count: 720 * 960 * 4)
      XCTAssertNotEqual(pixels, empty, "empty renderer: \(key)")
      XCTAssertTrue(outputs.insert(pixels).inserted, "garment did not change")
      let file = output.appendingPathComponent("\(key).png")
      let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil))
      CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
      XCTAssertTrue(CGImageDestinationFinalize(destination))
      XCTAssertGreaterThan(try Data(contentsOf: file).count, 1000)
    }
    XCTAssertFalse(LiveVtoBundledAssetIntegrity.identityMatches("n1b-fixture", "wrong-asset"))
  }
}
#endif
