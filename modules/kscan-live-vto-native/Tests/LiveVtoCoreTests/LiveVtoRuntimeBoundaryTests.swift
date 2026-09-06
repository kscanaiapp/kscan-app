import XCTest
@testable import LiveVtoCore

/// Structural guards for the boundaries this runtime's guarantees rest on.
/// Field-for-field port of Android's `RuntimeBoundaryTest.kt`, adapted to
/// Swift's module layout: Android enforces "no android.*/expo.* import"
/// against a flat directory with a named-file exception list; this port's
/// `ios/Core/` vs. `ios/{Drivers,Perception,root}` SPLIT already enforces the
/// zero-platform-import property structurally (only `ios/Core` is a member
/// of the `LiveVtoCore` SwiftPM target `swift test` compiles at all -- a
/// file outside it literally cannot be reached by this test binary if it
/// imported UIKit). This test still scans the source text directly, for the
/// same reason Android's does: a behavioural test would pass right up until
/// the moment someone added the import that breaks the guarantee, and a
/// structural directory split can still be defeated by moving a file.
final class LiveVtoRuntimeBoundaryTests: XCTestCase {

  private func swiftFiles(under relativeDir: String) throws -> [URL] {
    let root = GoldenFixtures.moduleRoot.appendingPathComponent(relativeDir)
    guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
    var out: [URL] = []
    for case let url as URL in enumerator where url.pathExtension == "swift" {
      out.append(url)
    }
    return out.sorted { $0.path < $1.path }
  }

  /// The geometry, deformation, replay, and perception-adapter stack (`ios/Core/`)
  /// must have ZERO UIKit/ExpoModulesCore/MediaPipe dependencies. This is
  /// what makes it runnable in a plain SwiftPM host test, and what makes it
  /// structurally impossible for deformation compute to touch a `UIView` or
  /// the main thread.
  func testCoreHasNoPlatformDependencies() throws {
    let bannedImports = ["UIKit", "ExpoModulesCore", "MediaPipeTasksVision", "CryptoKit", "CoreGraphics", "QuartzCore"]
    var offenders: [String] = []
    for file in try swiftFiles(under: "ios/Core") {
      let lines = (try? String(contentsOf: file, encoding: .utf8))?.components(separatedBy: "\n") ?? []
      for (i, line) in lines.enumerated() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        for banned in bannedImports where trimmed == "import \(banned)" {
          offenders.append("\(file.lastPathComponent):\(i + 1) \(trimmed)")
        }
      }
    }
    XCTAssertEqual(offenders, [], "ios/Core must stay free of platform imports so geometry runs off-device:\n" + offenders.joined(separator: "\n"))
  }

  /// The native runtime performs no network I/O of its own anywhere in the
  /// module -- not just `ios/Core`. It reads bundled resources and computes.
  /// Nothing it produces leaves the device.
  func testTheNativeRuntimeHasNoNetworkSurface() throws {
    let forbidden = ["URLSession", "URLRequest(", "CFNetwork", "Alamofire", "NWConnection", "NSURLConnection", "Socket("]
    var offenders: [String] = []
    for dir in ["ios/Core", "ios/Drivers", "ios/Perception", "ios/Camera"] {
      for file in try swiftFiles(under: dir) {
        let lines = (try? String(contentsOf: file, encoding: .utf8))?.components(separatedBy: "\n") ?? []
        for (i, line) in lines.enumerated() {
          let trimmed = line.trimmingCharacters(in: .whitespaces)
          if trimmed.hasPrefix("//") || trimmed.hasPrefix("*") { continue }
          for token in forbidden where line.contains(token) {
            offenders.append("\(file.lastPathComponent):\(i + 1) \(token) -> \(trimmed)")
          }
        }
      }
    }
    XCTAssertEqual(offenders, [], "the native Live VTO runtime must have no network surface:\n" + offenders.joined(separator: "\n"))
  }

  /// The bridge must expose only bounded commands and bounded reads. A new
  /// `Function`/`AsyncFunction`/`Prop` on the module is a new hole in the
  /// privacy boundary until it is reviewed, so the surface is pinned to
  /// EXACTLY Android's own real (not aspirational) N1 surface -- see
  /// `docs/vto-live-bridge-contract.md`.
  func testTheBridgeSurfaceIsPinned() throws {
    let moduleFile = GoldenFixtures.moduleRoot.appendingPathComponent("ios/KScanLiveVtoNativeModule.swift")
    let text = try String(contentsOf: moduleFile, encoding: .utf8)

    let pattern = try NSRegularExpression(pattern: #"(?:Async)?Function\("([^"]+)"\)|Prop\("([^"]+)"\)"#)
    let ns = text as NSString
    var declared = Set<String>()
    for match in pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      for groupIndex in [1, 2] {
        let range = match.range(at: groupIndex)
        if range.location != NSNotFound { declared.insert(ns.substring(with: range)) }
      }
    }

    let expected: Set<String> = [
      "active", "camera", "getCameraStatsJson", "getCapability", "getGeometrySnapshotJson",
      "getPerceptionStatsJson", "getReplayStatsJson", "perception", "replay",
    ]
    XCTAssertEqual(declared, expected, "the native bridge surface changed -- review the privacy boundary before updating this list")

    let banned = ["frame", "bitmap", "image", "pixel", "mask", "landmark", "mesh", "texture", "buffer"]
    for name in declared {
      let lowered = name.lowercased()
      for word in banned {
        XCTAssertFalse(lowered.contains(word), "bridge member '\(name)' suggests it carries frame data")
      }
    }
  }

  /// Same governed model, same checksum, on both platforms -- a divergence
  /// here would mean iOS is quietly running a different model than the one
  /// Android's N1-E measured against.
  func testBundledModelMatchesTheGovernedAndroidChecksum() throws {
    let iosModel = GoldenFixtures.moduleRoot.appendingPathComponent("ios/Assets/models/pose_landmarker_lite.task")
    guard FileManager.default.fileExists(atPath: iosModel.path) else {
      return XCTFail("bundled iOS model asset is missing: \(iosModel.path)")
    }
    let data = try Data(contentsOf: iosModel)
    let digest = SHA256Hex(data)
    XCTAssertEqual(digest, LiveVtoMediaPipePoseProviderChecksum.approvedSha256,
      "bundled iOS pose_landmarker_lite.task does not match the governed checksum in config/on-device-model-authority.json")
  }
}

/// A dependency-free SHA-256 (no `CryptoKit` import -- this test file lives
/// under `Tests/`, which is not part of the platform-import ban, but keeping
/// it free of platform crypto anyway means this specific check runs
/// identically wherever `swift test` runs). Textbook FIPS 180-4
/// implementation, standard constants.
private func SHA256Hex(_ data: Data) -> String {
  var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  let k: [UInt32] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]

  var message = [UInt8](data)
  let bitLength = UInt64(message.count) * 8
  message.append(0x80)
  while message.count % 64 != 56 { message.append(0) }
  for i in (0..<8).reversed() { message.append(UInt8((bitLength >> (8 * UInt64(i))) & 0xff)) }

  func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }

  for chunkStart in stride(from: 0, to: message.count, by: 64) {
    var w = [UInt32](repeating: 0, count: 64)
    for i in 0..<16 {
      let o = chunkStart + i * 4
      w[i] = UInt32(message[o]) << 24 | UInt32(message[o + 1]) << 16 | UInt32(message[o + 2]) << 8 | UInt32(message[o + 3])
    }
    for i in 16..<64 {
      let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
      let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
      w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
    }

    var (a, b, c, d, e, f, g, hh) = (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7])
    for i in 0..<64 {
      let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      let ch = (e & f) ^ (~e & g)
      let temp1 = hh &+ s1 &+ ch &+ k[i] &+ w[i]
      let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      let maj = (a & b) ^ (a & c) ^ (b & c)
      let temp2 = s0 &+ maj
      hh = g; g = f; f = e; e = d &+ temp1
      d = c; c = b; b = a; a = temp1 &+ temp2
    }
    h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
    h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
  }

  return h.map { String(format: "%08x", $0) }.joined()
}

/// Mirrors `LiveVtoMediaPipePoseProvider.approvedModelSha256` without
/// importing the ExpoModulesCore/MediaPipe-dependent provider file into this
/// platform-import-free test target.
private enum LiveVtoMediaPipePoseProviderChecksum {
  static let approvedSha256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"
}
