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
    ///
    /// CLAMP THE EDGES, THEN MEASURE — never clamp an origin and keep the raw
    /// extent. A box overflowing the TOP of the frame has a negative top edge;
    /// clamping the top to 0 while keeping the height does not clip the region,
    /// it SLIDES IT DOWN the body by the amount that overflowed, and a
    /// head-cropped subject's "upper body" lands on their waist.
    ///
    /// This mirrors how the Android half builds its rects
    /// (NormalizedRect.fromPixels), which is what makes the two agree. The
    /// shared vectors in test-vectors/vision-coordinate-parity.json pin it.
    private static func clamp01(_ value: Double) -> Double {
        if value.isNaN { return 0 }
        return max(0.0, min(1.0, value))
    }

    private static func flipY(_ rect: CGRect) -> NormalizedRect? {
        let left = clamp01(Double(rect.origin.x))
        let right = clamp01(Double(rect.origin.x) + Double(rect.width))
        let top = clamp01(1.0 - Double(rect.origin.y) - Double(rect.height))
        let bottom = clamp01(1.0 - Double(rect.origin.y))
        let width = right - left
        let height = bottom - top
        if width <= 0 || height <= 0 { return nil }
        return NormalizedRect(x: left, y: top, width: width, height: height)
    }

    /// `x` IS DELIBERATELY UNTOUCHED. A front-camera capture is already mirrored
    /// in PIXELS before this module sees it — mirrorSourcePreparation re-encodes
    /// the picker's asset — so mirroring x here would flip an already-flipped
    /// image and put the user's left shoulder on their right.
    private static func flipPoint(_ point: CGPoint) -> (x: Double, y: Double) {
        return (x: clamp01(Double(point.x)), y: clamp01(1.0 - Double(point.y)))
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

    // ── Test seams ──────────────────────────────────────────────────────────
    //
    // The conversion helpers are `private` because nothing on the runtime path
    // should reach around IOSPersonDetector to flip a coordinate itself — that
    // is how a second flip gets introduced. These two forwarders exist ONLY so
    // VisionCoordinateParityTests exercises the SHIPPING arithmetic against the
    // shared vector file rather than a copy written for the test.

    static func convertRectForTesting(_ rect: CGRect) -> NormalizedRect? {
        return flipY(rect)
    }

    static func convertPointForTesting(_ point: CGPoint) -> (x: Double, y: Double) {
        return flipPoint(point)
    }

    /**
     Run detection.

     WRAPPED IN AN AUTORELEASEPOOL, deliberately. Vision observations, the
     request handler and — above all — the segmentation pixel buffer are
     autoreleased objects sized in megabytes. Without an explicit pool they
     survive until the enclosing run-loop iteration drains, which on the
     module's dispatch queue can be well after the call returns. Extraction runs
     right after the app has decoded and re-encoded two copies of a photograph,
     so that is exactly the moment memory headroom is thinnest.

     The caller (`KScanPiiNativeModule.detectPersonRegions`, an `AsyncFunction`)
     already executes off the JavaScript thread; no additional dispatch is
     introduced here.
     */
    static func detect(cgImage: CGImage) -> Result {
        return autoreleasepool { () -> Result in
            detectInPool(cgImage: cgImage)
        }
    }

    private static func detectInPool(cgImage: CGImage) -> Result {
        let startedAt = Date()
        // Orientation .up: the caller supplies an image whose EXIF orientation
        // is already baked into the pixels by
        // services/mirror/mirrorSourcePreparation.ts. This is a PROVEN fact
        // about the input, not a default — passing anything else would rotate
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

        // ── Person segmentation: OPTIONAL, TRANSIENT, NEVER LEAVES NATIVE ────
        //
        // The mask exists to refine geometry confidence and nothing else. Its
        // whole lifecycle is:
        //
        //   created here → sampled to ONE number per person → released below
        //
        // It is never written to disk, never returned across the bridge, never
        // emitted to telemetry, and never retained past this function. What
        // crosses the bridge is a single `maskCoverage` double.
        //
        // It is also NOT garment segmentation. It separates a person from the
        // background; it cannot separate a jacket from the shirt underneath.
        //
        // Best-effort: a failure costs a confidence signal, never a region, so
        // it is caught and discarded rather than propagated. `.balanced` rather
        // than `.accurate` because the output is sampled on a coarse grid — a
        // sharper mask would change no answer.
        var maskPixelBuffer: CVPixelBuffer?
        if #available(iOS 15.0, *) {
            let segmentation = VNGeneratePersonSegmentationRequest()
            segmentation.qualityLevel = .balanced
            segmentation.outputPixelFormat = kCVPixelFormatType_OneComponent8
            if (try? handler.perform([segmentation])) != nil {
                maskPixelBuffer = segmentation.results?.first?.pixelBuffer
            }
        }
        // Released the moment geometry refinement is done — see the end of the
        // person loop. `defer` guarantees it even on an early return.
        defer { maskPixelBuffer = nil }

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
