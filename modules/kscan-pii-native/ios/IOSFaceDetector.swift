import Foundation
import Vision
import CoreGraphics

struct IOSFaceRect {
    let left: CGFloat
    let top: CGFloat
    let right: CGFloat
    let bottom: CGFloat
}

enum IOSDetectionResult {
    case success(faces: [IOSFaceRect], durationMs: Int)
    case failure(errorCode: NativePrivacyErrorCode, reason: String)
}

struct IOSFaceDetector {
    static func detect(image: CGImage) async -> IOSDetectionResult {
        let request = VNDetectFaceRectanglesRequest()
        request.revision = VNDetectFaceRectanglesRequestRevision3

        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
        let startedAt = Date()

        do {
            try handler.perform([request])
            let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            guard let results = request.results as? [VNFaceObservation] else {
                return .success(faces: [], durationMs: durationMs)
            }

            let imageWidth = CGFloat(image.width)
            let imageHeight = CGFloat(image.height)
            let faces = results.map { observation in
                let box = observation.boundingBox
                // Vision uses bottom-left origin; convert to top-left.
                let left = box.origin.x * imageWidth
                let top = (1 - box.origin.y - box.height) * imageHeight
                let right = left + box.width * imageWidth
                let bottom = top + box.height * imageHeight
                return IOSFaceRect(left: left, top: top, right: right, bottom: bottom)
            }
            return .success(faces: faces, durationMs: durationMs)
        } catch {
            return .failure(errorCode: .detectionFailed, reason: "Vision face detection failed: \(error.localizedDescription)")
        }
    }
}
