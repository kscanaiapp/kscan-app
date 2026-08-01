import Foundation

/**
 Wire models for person / body-region detection (Build 2.5 Step 3).

 Mirrors NativeExtractionModels.kt field for field. Both sides emit normalized
 0..1 geometry with a TOP-LEFT origin; the Vision bottom-left flip happens once,
 inside IOSPersonDetector.
 */

enum NativeExtractionConstants {
    static let extractorVersion = "native-person-regions-1.0.0"

    /// Apple Vision ships with the OS; there is no separately versioned model.
    static let detectorVersionAppleVision = "vision-1"
    static let detectorImplementation = "apple_vision"

    /// iOS produces a person segmentation mask; Android does not.
    static let segmentationMaskSupported = true

    static let minPersonConfidence = 0.3
    static let minLandmarkConfidence = 0.1

    /// Coverage is sampled on an NxN grid, not read per-pixel. See the note in
    /// IOSPersonDetector.coverage.
    static let maskSampleGrid = 24
    static let maskPositiveThreshold: UInt8 = 128
}

enum BodyLandmarkType: String {
    case nose
    case leftShoulder = "left_shoulder"
    case rightShoulder = "right_shoulder"
    case leftHip = "left_hip"
    case rightHip = "right_hip"
    case leftKnee = "left_knee"
    case rightKnee = "right_knee"
    case leftAnkle = "left_ankle"
    case rightAnkle = "right_ankle"

    static let all: [BodyLandmarkType] = [
        .nose, .leftShoulder, .rightShoulder, .leftHip, .rightHip,
        .leftKnee, .rightKnee, .leftAnkle, .rightAnkle,
    ]
}

struct NormalizedRect {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    func toDictionary() -> [String: Any] {
        return ["x": x, "y": y, "width": width, "height": height]
    }
}

struct BodyLandmark {
    let type: BodyLandmarkType
    let x: Double
    let y: Double
    let confidence: Double

    func toDictionary() -> [String: Any] {
        return ["type": type.rawValue, "x": x, "y": y, "confidence": confidence]
    }
}

struct DetectedPerson {
    let bounds: NormalizedRect
    let rankingExtent: NormalizedRect
    let confidence: Double
    let landmarks: [BodyLandmark]
    /// nil when the mask request was unavailable or failed. Neutral, never zero
    /// — zero would read as "the mask says this box is empty".
    let maskCoverage: Double?

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "bounds": bounds.toDictionary(),
            "rankingExtent": rankingExtent.toDictionary(),
            "confidence": confidence,
            "landmarks": landmarks.map { $0.toDictionary() },
        ]
        if let coverage = maskCoverage {
            dict["maskCoverage"] = coverage
        }
        return dict
    }
}

enum NativeExtractionStatus: String {
    case success
    case noPerson = "no_person"
    case unsupported
    case failed
}

struct NativePersonDetectionResult {
    let status: NativeExtractionStatus
    var persons: [DetectedPerson] = []
    var inputWidth: Int?
    var inputHeight: Int?
    var detectionDurationMs: Int?
    var totalDurationMs: Int?
    var warnings: [String] = []
    var errorCode: NativePrivacyErrorCode?
    var failureReason: String?

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "status": status.rawValue,
            "platform": "ios",
            "detectorImplementation": status == .unsupported
                ? "unavailable"
                : NativeExtractionConstants.detectorImplementation,
            "detectorVersion": NativeExtractionConstants.detectorVersionAppleVision,
            "extractorVersion": NativeExtractionConstants.extractorVersion,
            "persons": persons.map { $0.toDictionary() },
            "warnings": warnings,
        ]
        if let value = inputWidth { dict["inputWidth"] = value }
        if let value = inputHeight { dict["inputHeight"] = value }
        if let value = detectionDurationMs { dict["detectionDurationMs"] = value }
        if let value = totalDurationMs { dict["totalDurationMs"] = value }
        if let value = errorCode { dict["errorCode"] = value.rawValue }
        if let value = failureReason { dict["failureReason"] = value }
        return dict
    }
}

struct NativeExtractionCapabilities {
    let personDetectionSupported: Bool

    func toDictionary() -> [String: Any] {
        return [
            "personDetectionSupported": personDetectionSupported,
            "platform": "ios",
            "detectorImplementation": personDetectionSupported
                ? NativeExtractionConstants.detectorImplementation
                : "unavailable",
            "segmentationMaskSupported": NativeExtractionConstants.segmentationMaskSupported,
            "supportedLandmarks": BodyLandmarkType.all.map { $0.rawValue },
            "maxWidth": NativePrivacyConstants.maxWidth,
            "maxHeight": NativePrivacyConstants.maxHeight,
            "maxPixels": NativePrivacyConstants.maxPixels,
            "extractorVersion": NativeExtractionConstants.extractorVersion,
        ]
    }
}
