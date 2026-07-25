import Foundation

enum NativePrivacyConstants {
    static let moduleName = "KScanPiiNative"

    static let sanitizerVersion = "native-face-mask-poc-1.0.0"
    static let detectorVersionAppleVision = "1"

    static let acceptedUriScheme = "file"
    static let acceptedMimeTypes = Set(["image/jpeg", "image/png"])
    static let outputMimeType = "image/png"
    static let outputExtension = "png"

    static let maxWidth = 4096
    static let maxHeight = 4096
    static let maxPixels = 16_777_216

    static let defaultPaddingRatio = 0.15
    static let minPaddingRatio = 0.0
    static let maxPaddingRatio = 0.5

    static let iouDeduplicationThreshold = 0.5

    // Opaque black.
    static let redactionColorR: CGFloat = 0
    static let redactionColorG: CGFloat = 0
    static let redactionColorB: CGFloat = 0
    static let redactionColorA: CGFloat = 1

    static let checksumAlgorithm = "fnv1a-dual-lane-64"

    static let cacheNamespace = "kscan-pii-native"
    static let outputFilePrefix = "kscan-pii-"
}
