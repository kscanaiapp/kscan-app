import Foundation

enum NativePrivacyStatus: String {
    case success = "success"
    case noFaces = "no_faces"
    case unsupported = "unsupported"
    case failed = "failed"
}

enum NativePrivacyErrorCode: String {
    case invalidInput = "INVALID_INPUT"
    case invalidUri = "INVALID_URI"
    case unsupportedScheme = "UNSUPPORTED_SCHEME"
    case unsupportedFormat = "UNSUPPORTED_FORMAT"
    case imageTooLarge = "IMAGE_TOO_LARGE"
    case decodeFailed = "DECODE_FAILED"
    case orientationFailed = "ORIENTATION_FAILED"
    case detectorUnavailable = "DETECTOR_UNAVAILABLE"
    case detectionFailed = "DETECTION_FAILED"
    case invalidRegion = "INVALID_REGION"
    case maskingFailed = "MASKING_FAILED"
    case encodingFailed = "ENCODING_FAILED"
    case verificationFailed = "VERIFICATION_FAILED"
    case cleanupRejected = "CLEANUP_REJECTED"
    case cleanupFailed = "CLEANUP_FAILED"
    case internalError = "INTERNAL_ERROR"
}

struct NativeFaceMaskInput {
    let imageUri: String
    let paddingRatio: Double
}

struct NativeFaceRegion {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct NativeFaceMaskResult {
    let status: NativePrivacyStatus
    let platform: String
    let detectorImplementation: String
    let detectorVersion: String
    let sanitizerVersion: String
    let inputWidth: Int?
    let inputHeight: Int?
    let outputWidth: Int?
    let outputHeight: Int?
    let facesDetected: Int
    let facesAccepted: Int
    let facesMasked: Int
    let regionsChanged: Int
    let regionsAlreadyRedacted: Int
    let pixelsChanged: Bool
    let sanitizedUri: String?
    let inputChecksum: String?
    let outputChecksum: String?
    let checksumAlgorithm: String?
    let detectionDurationMs: Int?
    let maskingDurationMs: Int?
    let encodingDurationMs: Int?
    let verificationDurationMs: Int?
    let totalDurationMs: Int?
    let warnings: [String]
    let errorCode: NativePrivacyErrorCode?
    let failureReason: String?

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "status": status.rawValue,
            "platform": platform,
            "detectorImplementation": detectorImplementation,
            "detectorVersion": detectorVersion,
            "sanitizerVersion": sanitizerVersion,
            "facesDetected": facesDetected,
            "facesAccepted": facesAccepted,
            "facesMasked": facesMasked,
            "regionsChanged": regionsChanged,
            "regionsAlreadyRedacted": regionsAlreadyRedacted,
            "pixelsChanged": pixelsChanged,
            "warnings": warnings,
        ]
        if let inputWidth = inputWidth { dict["inputWidth"] = inputWidth }
        if let inputHeight = inputHeight { dict["inputHeight"] = inputHeight }
        if let outputWidth = outputWidth { dict["outputWidth"] = outputWidth }
        if let outputHeight = outputHeight { dict["outputHeight"] = outputHeight }
        if let sanitizedUri = sanitizedUri { dict["sanitizedUri"] = sanitizedUri }
        if let inputChecksum = inputChecksum { dict["inputChecksum"] = inputChecksum }
        if let outputChecksum = outputChecksum { dict["outputChecksum"] = outputChecksum }
        if let checksumAlgorithm = checksumAlgorithm { dict["checksumAlgorithm"] = checksumAlgorithm }
        if let detectionDurationMs = detectionDurationMs { dict["detectionDurationMs"] = detectionDurationMs }
        if let maskingDurationMs = maskingDurationMs { dict["maskingDurationMs"] = maskingDurationMs }
        if let encodingDurationMs = encodingDurationMs { dict["encodingDurationMs"] = encodingDurationMs }
        if let verificationDurationMs = verificationDurationMs { dict["verificationDurationMs"] = verificationDurationMs }
        if let totalDurationMs = totalDurationMs { dict["totalDurationMs"] = totalDurationMs }
        if let errorCode = errorCode { dict["errorCode"] = errorCode.rawValue }
        if let failureReason = failureReason { dict["failureReason"] = failureReason }
        return dict
    }
}

struct NativePrivacyCapabilities {
    let supported: Bool
    let platform: String
    let detectorImplementation: String
    let acceptedUriSchemes: [String]
    let acceptedMimeTypes: [String]
    let outputMimeType: String
    let maxWidth: Int
    let maxHeight: Int
    let maxPixels: Int
    let sanitizerVersion: String

    func toDictionary() -> [String: Any] {
        return [
            "supported": supported,
            "platform": platform,
            "detectorImplementation": detectorImplementation,
            "acceptedUriSchemes": acceptedUriSchemes,
            "acceptedMimeTypes": acceptedMimeTypes,
            "outputMimeType": outputMimeType,
            "maxWidth": maxWidth,
            "maxHeight": maxHeight,
            "maxPixels": maxPixels,
            "sanitizerVersion": sanitizerVersion,
        ]
    }
}

// ── License-plate REGION screening ───────────────────────────────────────────
//
// A separate status enum rather than a new case on NativePrivacyStatus, and a
// separate result struct rather than a reuse of NativeFaceMaskResult. Both
// follow the precedent the person-detection capability already set with
// NativeExtractionStatus.
//
// The result struct is the load-bearing one. NativeFaceMaskResult's counters are
// literally named facesDetected / facesAccepted / facesMasked, and they cross the
// bridge under those keys. Reporting three masked plates as `facesDetected: 3`
// would be a lie told by a privacy engine about what it did — and the JS layer
// this feeds (services/privacyImageUpload.ts) reports faceMaskApplied and
// plateMaskApplied as two independent claims, so it needs two independent
// answers. The SHAPE is mirrored field for field on purpose; only the three
// counters, the status type and the version strings differ.

enum NativePlateStatus: String {
    case success = "success"
    /// "No region matched the plate GEOMETRY" — never "this image contains no
    /// plate". See the limitations in IOSPlateDetector's header.
    case noPlates = "no_plates"
    case unsupported = "unsupported"
    case failed = "failed"
}

struct NativePlateMaskInput {
    let imageUri: String
    let paddingRatio: Double
}

struct NativePlateMaskResult {
    let status: NativePlateStatus
    let platform: String
    let detectorImplementation: String
    let detectorVersion: String
    let sanitizerVersion: String
    /// Always false on this path. Named to match the shared cross-platform
    /// contract (recognizedTextConsumed, not ocrPerformed): on iOS
    /// VNDetectTextRectanglesRequest never performs character recognition at
    /// all, so both readings of the claim are true here, but the field name
    /// must agree with Android, where recognition DOES run internally and
    /// only "the text was never consumed" is the honest claim. Emitted rather
    /// than assumed so that a caller making a privacy claim reads it from the
    /// result instead of from a comment. See IOSPlateDetector's header.
    let recognizedTextConsumed: Bool
    let inputWidth: Int?
    let inputHeight: Int?
    let outputWidth: Int?
    let outputHeight: Int?
    let platesDetected: Int
    let platesAccepted: Int
    let platesMasked: Int
    let regionsChanged: Int
    let regionsAlreadyRedacted: Int
    let pixelsChanged: Bool
    let sanitizedUri: String?
    let inputChecksum: String?
    let outputChecksum: String?
    let checksumAlgorithm: String?
    let detectionDurationMs: Int?
    let maskingDurationMs: Int?
    let encodingDurationMs: Int?
    let verificationDurationMs: Int?
    let totalDurationMs: Int?
    let warnings: [String]
    let errorCode: NativePrivacyErrorCode?
    let failureReason: String?

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "status": status.rawValue,
            "platform": platform,
            "detectorImplementation": detectorImplementation,
            "detectorVersion": detectorVersion,
            "sanitizerVersion": sanitizerVersion,
            "recognizedTextConsumed": recognizedTextConsumed,
            "platesDetected": platesDetected,
            "platesAccepted": platesAccepted,
            "platesMasked": platesMasked,
            "regionsChanged": regionsChanged,
            "regionsAlreadyRedacted": regionsAlreadyRedacted,
            "pixelsChanged": pixelsChanged,
            "warnings": warnings,
        ]
        if let inputWidth = inputWidth { dict["inputWidth"] = inputWidth }
        if let inputHeight = inputHeight { dict["inputHeight"] = inputHeight }
        if let outputWidth = outputWidth { dict["outputWidth"] = outputWidth }
        if let outputHeight = outputHeight { dict["outputHeight"] = outputHeight }
        if let sanitizedUri = sanitizedUri { dict["sanitizedUri"] = sanitizedUri }
        if let inputChecksum = inputChecksum { dict["inputChecksum"] = inputChecksum }
        if let outputChecksum = outputChecksum { dict["outputChecksum"] = outputChecksum }
        if let checksumAlgorithm = checksumAlgorithm { dict["checksumAlgorithm"] = checksumAlgorithm }
        if let detectionDurationMs = detectionDurationMs { dict["detectionDurationMs"] = detectionDurationMs }
        if let maskingDurationMs = maskingDurationMs { dict["maskingDurationMs"] = maskingDurationMs }
        if let encodingDurationMs = encodingDurationMs { dict["encodingDurationMs"] = encodingDurationMs }
        if let verificationDurationMs = verificationDurationMs { dict["verificationDurationMs"] = verificationDurationMs }
        if let totalDurationMs = totalDurationMs { dict["totalDurationMs"] = totalDurationMs }
        if let errorCode = errorCode { dict["errorCode"] = errorCode.rawValue }
        if let failureReason = failureReason { dict["failureReason"] = failureReason }
        return dict
    }
}

struct NativePlateCapabilities {
    let supported: Bool
    let platform: String
    let detectorImplementation: String
    let detectorVersion: String
    let sanitizerVersion: String
    /// Same cross-platform field as NativePlateMaskResult; see its comment.
    let recognizedTextConsumed: Bool
    let acceptedUriSchemes: [String]
    let acceptedMimeTypes: [String]
    let outputMimeType: String
    let maxWidth: Int
    let maxHeight: Int
    let maxPixels: Int
    let defaultPaddingRatio: Double
    let minPaddingRatio: Double
    let maxPaddingRatio: Double

    /**
     The geometry thresholds are reported, not just applied.

     A caller deciding how much weight to put on a `no_plates` result needs to
     know what "plate-like" meant to the build it is talking to. Without this the
     only way to find out is to read the Swift, which a QA pass on a shipped
     binary cannot do. It also gives the shared test suite something to pin, so a
     threshold cannot be retuned without the change being visible.
     */
    func toDictionary() -> [String: Any] {
        // Annotated, and built as its own binding rather than inlined below. The
        // ratios are Double and the pixel floors are Int, so as an inline nested
        // literal this is a heterogeneous collection Swift refuses to infer.
        let geometryThresholds: [String: Any] = [
            "minAspectRatio": NativePrivacyConstants.plateMinAspectRatio,
            "maxAspectRatio": NativePrivacyConstants.plateMaxAspectRatio,
            "minRelativeWidth": NativePrivacyConstants.plateMinRelativeWidth,
            "minRelativeArea": NativePrivacyConstants.plateMinRelativeArea,
            "minPixelWidth": NativePrivacyConstants.plateMinPixelWidth,
            "minPixelHeight": NativePrivacyConstants.plateMinPixelHeight,
        ]

        return [
            "supported": supported,
            "platform": platform,
            "detectorImplementation": detectorImplementation,
            "detectorVersion": detectorVersion,
            "sanitizerVersion": sanitizerVersion,
            "recognizedTextConsumed": recognizedTextConsumed,
            "acceptedUriSchemes": acceptedUriSchemes,
            "acceptedMimeTypes": acceptedMimeTypes,
            "outputMimeType": outputMimeType,
            "maxWidth": maxWidth,
            "maxHeight": maxHeight,
            "maxPixels": maxPixels,
            "defaultPaddingRatio": defaultPaddingRatio,
            "minPaddingRatio": minPaddingRatio,
            "maxPaddingRatio": maxPaddingRatio,
            "geometryThresholds": geometryThresholds,
        ]
    }
}

struct NativeCleanupResult {
    let deleted: Bool
    let rejected: Bool
    let warnings: [String]

    func toDictionary() -> [String: Any] {
        return [
            "deleted": deleted,
            "rejected": rejected,
            "warnings": warnings,
        ]
    }
}
