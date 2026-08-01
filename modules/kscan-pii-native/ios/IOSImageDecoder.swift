import Foundation
import ImageIO
import CoreGraphics
import UIKit

enum IOSDecodeResult {
    case success(image: CGImage, mimeType: String, width: Int, height: Int)
    case failure(errorCode: NativePrivacyErrorCode, reason: String)
}

struct IOSImageDecoder {
    static func decodeFileUri(_ uriString: String) -> IOSDecodeResult {
        guard let url = URL(string: uriString) else {
            return .failure(errorCode: .invalidUri, reason: "Failed to parse URI.")
        }

        guard url.scheme == "file" else {
            return .failure(errorCode: .unsupportedScheme, reason: "Unsupported URI scheme: \(url.scheme ?? "null"). Only file:// is accepted.")
        }

        let path = url.path
        let fileURL = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: fileURL.path),
              FileManager.default.isReadableFile(atPath: fileURL.path) else {
            return .failure(errorCode: .invalidUri, reason: "File does not exist or is not readable: \(fileURL.path)")
        }

        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else {
            return .failure(errorCode: .decodeFailed, reason: "Failed to read image properties.")
        }

        let pixelWidth = properties[kCGImagePropertyPixelWidth as String] as? Int ?? 0
        let pixelHeight = properties[kCGImagePropertyPixelHeight as String] as? Int ?? 0
        guard pixelWidth > 0, pixelHeight > 0 else {
            return .failure(errorCode: .decodeFailed, reason: "Invalid image dimensions: \(pixelWidth)x\(pixelHeight).")
        }

        if pixelWidth > NativePrivacyConstants.maxWidth || pixelHeight > NativePrivacyConstants.maxHeight {
            return .failure(errorCode: .imageTooLarge, reason: "Image dimensions \(pixelWidth)x\(pixelHeight) exceed the maximum of \(NativePrivacyConstants.maxWidth)x\(NativePrivacyConstants.maxHeight).")
        }

        let pixelCount = pixelWidth * pixelHeight
        if pixelCount > NativePrivacyConstants.maxPixels {
            return .failure(errorCode: .imageTooLarge, reason: "Pixel count \(pixelCount) exceeds the maximum of \(NativePrivacyConstants.maxPixels).")
        }

        let uti = CGImageSourceGetType(source) as String? ?? ""
        let mimeType = utiToMimeType(uti)
        guard NativePrivacyConstants.acceptedMimeTypes.contains(mimeType) else {
            return .failure(errorCode: .unsupportedFormat, reason: "Unsupported image format: \(mimeType). Accepted: \(NativePrivacyConstants.acceptedMimeTypes.sorted()).")
        }

        let orientationValue = properties[kCGImagePropertyOrientation as String] as? UInt32 ?? 1

        guard let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return .failure(errorCode: .decodeFailed, reason: "Failed to decode image.")
        }

        let normalized = normalizeOrientation(cgImage, orientation: CGImagePropertyOrientation(rawValue: orientationValue) ?? .up)
        return .success(image: normalized, mimeType: mimeType, width: normalized.width, height: normalized.height)
    }

    private static func utiToMimeType(_ uti: String) -> String {
        switch uti {
        case "public.jpeg", "jpeg":
            return "image/jpeg"
        case "public.png", "png":
            return "image/png"
        default:
            return uti
        }
    }

    private static func normalizeOrientation(_ image: CGImage, orientation: CGImagePropertyOrientation) -> CGImage {
        switch orientation {
        case .up:
            return image
        case .upMirrored, .down, .downMirrored, .leftMirrored, .right, .rightMirrored, .left:
            break
        @unknown default:
            return image
        }

        let (rotationRadians, mirrorHorizontal) = transformForOrientation(orientation)
        let width = image.width
        let height = image.height

        var transform = CGAffineTransform.identity
        if mirrorHorizontal {
            transform = transform.translatedBy(x: CGFloat(width), y: 0).scaledBy(x: -1, y: 1)
        }
        transform = transform.rotated(by: rotationRadians)

        let outputSize = rotatedSize(width: width, height: height, radians: rotationRadians)
        guard let context = CGContext(
            data: nil,
            width: Int(outputSize.width),
            height: Int(outputSize.height),
            bitsPerComponent: image.bitsPerComponent,
            bytesPerRow: 0,
            space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: image.bitmapInfo.rawValue
        ) else {
            return image
        }

        context.translateBy(x: outputSize.width / 2, y: outputSize.height / 2)
        context.concatenate(transform)
        context.draw(image, in: CGRect(x: -CGFloat(width) / 2, y: -CGFloat(height) / 2, width: CGFloat(width), height: CGFloat(height)))

        return context.makeImage() ?? image
    }

    // NOTE: .left/.right rotation direction corrected in source (previously
    // swapped). This correction has not yet been validated against a real
    // rotated-EXIF image on macOS/Xcode -- pending compilation and XCTest on
    // that platform, since no macOS toolchain is available here.
    private static func transformForOrientation(_ orientation: CGImagePropertyOrientation) -> (CGFloat, Bool) {
        switch orientation {
        case .up:
            return (0, false)
        case .upMirrored:
            return (0, true)
        case .down:
            return (.pi, false)
        case .downMirrored:
            return (.pi, true)
        case .left:
            return (-.pi / 2, false)
        case .leftMirrored:
            return (.pi / 2, true)
        case .right:
            return (.pi / 2, false)
        case .rightMirrored:
            return (-.pi / 2, true)
        @unknown default:
            return (0, false)
        }
    }

    private static func rotatedSize(width: Int, height: Int, radians: CGFloat) -> CGSize {
        let isPortrait = abs(sin(radians)) > 0.5
        return isPortrait ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
    }
}
