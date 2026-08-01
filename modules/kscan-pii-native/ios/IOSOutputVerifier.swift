import Foundation
import CoreGraphics
import ImageIO

enum IOSVerificationResult {
    case success(outputWidth: Int, outputHeight: Int, outputChecksum: String, durationMs: Int)
    case failure(errorCode: NativePrivacyErrorCode, reason: String)
}

struct IOSOutputVerifier {
    static func verify(
        outputFile: URL,
        expectedWidth: Int,
        expectedHeight: Int,
        regions: [IOSNormalizedFaceBox]
    ) -> IOSVerificationResult {
        let startedAt = Date()

        guard FileManager.default.fileExists(atPath: outputFile.path),
              let attributes = try? FileManager.default.attributesOfItem(atPath: outputFile.path),
              let fileSize = attributes[.size] as? UInt64, fileSize > 0 else {
            return .failure(errorCode: .verificationFailed, reason: "Output file is missing or empty: \(outputFile.path)")
        }

        guard let source = CGImageSourceCreateWithURL(outputFile as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return .failure(errorCode: .verificationFailed, reason: "Failed to re-decode persisted output.")
        }

        guard cgImage.width == expectedWidth, cgImage.height == expectedHeight else {
            return .failure(errorCode: .verificationFailed, reason: "Output dimensions \(cgImage.width)x\(cgImage.height) do not match expected \(expectedWidth)x\(expectedHeight).")
        }

        guard let pixels = IOSFaceRedactor.pixelsFromCGImage(cgImage) else {
            return .failure(errorCode: .verificationFailed, reason: "Failed to read output pixels for verification.")
        }

        let width = cgImage.width
        for region in regions {
            let x1 = max(0, region.x)
            let y1 = max(0, region.y)
            let x2 = min(width, region.x + region.width)
            let y2 = min(cgImage.height, region.y + region.height)
            guard x2 > x1, y2 > y1 else { continue }

            for y in y1..<y2 {
                for x in x1..<x2 {
                    let idx = (y * width + x) * 4
                    let r = pixels[idx]
                    let g = pixels[idx + 1]
                    let b = pixels[idx + 2]
                    let a = pixels[idx + 3]
                    if r != 0 || g != 0 || b != 0 || a != 255 {
                        return .failure(errorCode: .verificationFailed, reason: "Redacted region at (\(x1),\(y1),\(x2 - x1),\(y2 - y1)) is not opaque black.")
                    }
                }
            }
        }

        let checksum = checksumBuffer(pixels)
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        return .success(outputWidth: cgImage.width, outputHeight: cgImage.height, outputChecksum: checksum, durationMs: durationMs)
    }

    /**
     * Deterministic, dependency-free 64-bit FNV-1a dual-lane checksum.
     *
     * Mirrors the audited TypeScript implementation in
     * services/privacy/onDeviceMasking/rgbaMasking.ts.
     */
    static func checksumBuffer(_ bytes: Data) -> String {
        var h1: UInt32 = 0x811c9dc5
        var h2: UInt32 = 0x9e3779b9

        for byte in bytes {
            let unsigned = UInt32(byte)
            h1 ^= unsigned
            h1 = h1 &* 0x01000193
            h2 = (h2 ^ unsigned) &+ ((h2 << 6) &+ (h2 >> 2))
        }

        let hex1 = String(format: "%08x", h1)
        let hex2 = String(format: "%08x", h2)
        let lengthHex = String(format: "%08x", UInt32(bytes.count))
        return "\(hex1)\(hex2)\(lengthHex)"
    }

    static func checksumBuffer(_ bytes: [UInt8]) -> String {
        return checksumBuffer(Data(bytes))
    }
}
