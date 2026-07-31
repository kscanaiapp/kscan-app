import Foundation
import Vision
import CoreGraphics

/**
 Person and body-landmark detection for Mirror Selfie extraction (Build 2.5 Step 3).

 Uses three Apple Vision requests, all on-device, all OS-resident — no model
 file is bundled, redistributed or downloaded:

   VNDetectHumanRectanglesRequest    person bounding boxes      (iOS 13+)
   VNDetectHumanBodyPoseRequest      body joints per person     (iOS 14+)
   VNGeneratePersonSegmentationRequest  person mask             (iOS 15+)

 ── COORDINATE SPACE ────────────────────────────────────────────────────────

 Vision reports normalized coordinates with the ORIGIN AT BOTTOM-LEFT and y
 increasing upward. Every consumer of this module — the JS pipeline, the crop
 generator, expo-image-manipulator — uses top-left origin with y increasing
 downward. The flip happens exactly once, here, in `flipY`. Doing it anywhere
 else, or twice, would place every garment region upside down on the body, and
 the failure would look like a detector problem rather than an axis problem.

 ── PARITY WITH ANDROID ─────────────────────────────────────────────────────

 iOS can enumerate people directly, so `rankingExtent` and `bounds` are the
 same human rectangle. Android has to rank on face boxes because ML Kit pose
 detection returns one subject. The fields exist so the CALLER's ranking rule is
 identical on both platforms; see AndroidPersonDetector for the other half.

 The segmentation mask is iOS-only. It is passed to the caller as
 `maskCoverage`, which may only ever DEMOTE a region's confidence and never
 promote one — so its absence on Android cannot make the two platforms disagree
 about which regions exist.
 */
enum IOSPersonDetector {

    enum Result {
        case success(persons: [DetectedPerson], durationMs: Int)
        case failure(errorCode: NativePrivacyErrorCode, reason: String)
    }

    /// Vision's bottom-left origin → the top-left origin everything else uses.
    private static func flipY(_ rect: CGRect) -> NormalizedRect? {
        let x = max(0.0, min(1.0, Double(rect.origin.x)))
        let width = max(0.0, min(1.0 - x, Double(rect.width)))
        let top = max(0.0, min(1.0, 1.0 - Double(rect.origin.y) - Double(rect.height)))
        let height = max(0.0, min(1.0 - top, Double(rect.height)))
        if width <= 0 || height <= 0 { return nil }
        return NormalizedRect(x: x, y: top, width: width, height: height)
    }

    private static func flipPoint(_ point: CGPoint) -> (x: Double, y: Double) {
        return (
            x: max(0.0, min(1.0, Double(point.x))),
            y: max(0.0, min(1.0, 1.0 - Double(point.y)))
        )
    }

    /// The joint subset both platforms report. Not the full 19 Vision offers.
    private static let jointMapping: [(BodyLandmarkType, VNHumanBodyPoseObservation.JointName)] = [
        (.nose, .nose),
        (.leftShoulder, .leftShoulder),
        (.rightShoulder, .rightShoulder),
        (.leftHip, .leftHip),
        (.rightHip, .rightHip),
        (.leftKnee, .leftKnee),
        (.rightKnee, .rightKnee),
        (.leftAnkle, .leftAnkle),
        (.rightAnkle, .rightAnkle),
    ]

    static func detect(cgImage: CGImage) -> Result {
        let startedAt = Date()
        // Orientation .up: the caller supplies an image whose EXIF orientation
        // is already baked into the pixels. Passing anything else would rotate
        // the coordinate space a second time.
        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])

        let humanRequest = VNDetectHumanRectanglesRequest()
        if #available(iOS 15.0, *) {
            // Include people whose lower body is out of frame — a mirror selfie
            // routinely crops at the thigh, and excluding those subjects would
            // reject the most common input this feature exists to handle.
            humanRequest.upperBodyOnly = false
        }
        let poseRequest = VNDetectHumanBodyPoseRequest()

        do {
            try handler.perform([humanRequest, poseRequest])
        } catch {
            return .failure(
                errorCode: .detectionFailed,
                reason: "Vision request failed: \(error.localizedDescription)"
            )
        }

        let humans = (humanRequest.results ?? [])
            .filter { $0.confidence >= Float(NativeExtractionConstants.minPersonConfidence) }
        let poses = poseRequest.results ?? []

        // Person mask is best-effort. A failure here costs a confidence signal,
        // never a region — so it is caught and discarded rather than propagated.
        var maskPixelBuffer: CVPixelBuffer?
        if #available(iOS 15.0, *) {
            let segmentation = VNGeneratePersonSegmentationRequest()
            segmentation.qualityLevel = .balanced
            segmentation.outputPixelFormat = kCVPixelFormatType_OneComponent8
            if (try? handler.perform([segmentation])) != nil {
                maskPixelBuffer = segmentation.results?.first?.pixelBuffer
            }
        }

        var persons: [DetectedPerson] = []

        for human in humans {
            guard let bounds = flipY(human.boundingBox) else { continue }

            // Attach the pose whose joints fall inside this person's box. Vision
            // does not link the two request types, so the association is made by
            // containment — a measurement, not a guess.
            let matchedPose = poses.first { pose in
                guard let root = try? pose.recognizedPoint(.root), root.confidence > 0 else {
                    return false
                }
                return human.boundingBox.contains(root.location)
            }

            var landmarks: [BodyLandmark] = []
            if let pose = matchedPose {
                for (type, jointName) in jointMapping {
                    guard let point = try? pose.recognizedPoint(jointName) else { continue }
                    if point.confidence < Float(NativeExtractionConstants.minLandmarkConfidence) {
                        continue
                    }
                    let flipped = flipPoint(point.location)
                    landmarks.append(
                        BodyLandmark(
                            type: type,
                            x: flipped.x,
                            y: flipped.y,
                            confidence: Double(min(max(point.confidence, 0), 1))
                        )
                    )
                }
            }

            persons.append(
                DetectedPerson(
                    bounds: bounds,
                    // iOS enumerates people directly, so the ranking basis and
                    // the body extent are the same rectangle.
                    rankingExtent: bounds,
                    confidence: Double(min(max(human.confidence, 0), 1)),
                    landmarks: landmarks,
                    maskCoverage: maskPixelBuffer.flatMap { coverage(of: $0, within: bounds) }
                )
            )
        }

        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        return .success(persons: persons, durationMs: durationMs)
    }

    /**
     Fraction of a normalized rect the person mask fills.

     Sampled on a coarse grid rather than read per-pixel: this is a coverage
     heuristic used to flag a region for review, and walking a full-resolution
     mask to compute it would cost more than the detection it annotates.
     */
    private static func coverage(of buffer: CVPixelBuffer, within rect: NormalizedRect) -> Double? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        if width <= 0 || height <= 0 { return nil }

        let pointer = base.assumingMemoryBound(to: UInt8.self)
        let samples = NativeExtractionConstants.maskSampleGrid
        var hits = 0
        var total = 0

        for row in 0..<samples {
            for column in 0..<samples {
                let u = rect.x + rect.width * (Double(column) + 0.5) / Double(samples)
                let v = rect.y + rect.height * (Double(row) + 0.5) / Double(samples)
                let px = Int(u * Double(width))
                let py = Int(v * Double(height))
                if px < 0 || py < 0 || px >= width || py >= height { continue }
                total += 1
                if pointer[py * bytesPerRow + px] >= NativeExtractionConstants.maskPositiveThreshold {
                    hits += 1
                }
            }
        }

        if total == 0 { return nil }
        return Double(hits) / Double(total)
    }
}
