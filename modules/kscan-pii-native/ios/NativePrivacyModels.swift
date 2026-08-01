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
