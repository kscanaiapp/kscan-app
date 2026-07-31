import Foundation
import CoreGraphics

enum IOSRedactionResult {
    case success(output: CGImage, regionsChanged: Int, regionsAlreadyRedacted: Int, pixelsChanged: Bool, durationMs: Int)
    case failure(errorCode: NativePrivacyErrorCode, reason: String)
}

struct IOSFaceRedactor {
    static func redactRegions(image: CGImage, regions: [IOSNormalizedFaceBox]) -> IOSRedactionResult {
        let startedAt = Date()
        let width = image.width
        let height = image.height

        let colorSpace = image.colorSpace ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return .failure(errorCode: .maskingFailed, reason: "Failed to create Core Graphics context for redaction.")
        }

        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(
            red: NativePrivacyConstants.redactionColorR,
            green: NativePrivacyConstants.redactionColorG,
            blue: NativePrivacyConstants.redactionColorB,
            alpha: NativePrivacyConstants.redactionColorA
        )

        let inputPixels = context.data.map { Data(bytes: $0, count: width * height * 4) }

        var regionsChanged = 0
        var regionsAlreadyRedacted = 0

        for region in regions {
            let x1 = max(0, region.x)
            let y1 = max(0, region.y)
            let x2 = min(width, region.x + region.width)
            let y2 = min(height, region.y + region.height)
            guard x2 > x1, y2 > y1 else { continue }

            let rect = CGRect(x: x1, y: y1, width: x2 - x1, height: y2 - y1)
            if let inputPixels = inputPixels, isRegionAlreadyBlack(pixels: inputPixels, width: width, region: region) {
                regionsAlreadyRedacted += 1
            } else {
                regionsChanged += 1
            }
            context.fill(rect)
        }

        guard let output = context.makeImage() else {
            return .failure(errorCode: .maskingFailed, reason: "Failed to create redacted CGImage.")
        }

        let outputPixels = pixelsFromCGImage(output)
        let pixelsChanged: Bool = {
            guard let input = inputPixels, let output = outputPixels else { return true }
            return input != output
        }()

        // An accepted region that was already fully opaque black is a valid
        // masked state -- it must not fail just because its own bytes did
        // not change. Only regions that actually needed a change
        // (regionsChanged) are required to have produced a byte difference.
        if regionsChanged > 0 && !pixelsChanged {
            return .failure(errorCode: .maskingFailed, reason: "Masking invariant violated: \(regionsChanged) regions needed changes but no pixels changed.")
        }

        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        return .success(output: output, regionsChanged: regionsChanged, regionsAlreadyRedacted: regionsAlreadyRedacted, pixelsChanged: pixelsChanged, durationMs: durationMs)
    }

    private static func isRegionAlreadyBlack(pixels: Data, width: Int, region: IOSNormalizedFaceBox) -> Bool {
        let height = pixels.count / (width * 4)
        let x1 = max(0, region.x)
        let y1 = max(0, region.y)
        let x2 = min(width, region.x + region.width)
        let y2 = min(height, region.y + region.height)
        guard x2 > x1, y2 > y1 else { return false }

        for y in y1..<y2 {
            for x in x1..<x2 {
                let idx = (y * width + x) * 4
                let r = pixels[idx]
                let g = pixels[idx + 1]
                let b = pixels[idx + 2]
                let a = pixels[idx + 3]
                if r != 0 || g != 0 || b != 0 || a != 255 {
                    return false
                }
            }
        }
        return true
    }

    static func pixelsFromCGImage(_ image: CGImage) -> Data? {
        let width = image.width
        let height = image.height
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let data = context.data else { return nil }
        return Data(bytes: data, count: width * height * 4)
    }
}
