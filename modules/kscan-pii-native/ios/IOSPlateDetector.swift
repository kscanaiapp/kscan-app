import Foundation
import Vision
import CoreGraphics

/**
 License-plate REGION screening.

 ── WHY TEXT RECTANGLES AND NOT TEXT RECOGNITION ────────────────────────────

 This runs `VNDetectTextRectanglesRequest`, which answers "where are there
 text-shaped pixels" and nothing else. It is not a downgrade from
 `VNRecognizeTextRequest` chosen for speed — it is chosen because it CANNOT
 read. A recognizer would materialize the plate number as a string in this
 process, and from that moment the module would be one stray log line, one
 crash report, one telemetry field away from having leaked it. A detector that
 never produces characters cannot leak characters. `reportCharacterBoxes` is
 set false for the same reason at the next level down: per-glyph geometry is
 not needed to place a mask, and per-glyph geometry is the input a downstream
 classifier would need to reconstruct the text this module refuses to read.

 The module's README lists OCR as a non-goal. That remains true after this
 file: no character is recognized anywhere on this path.

 ── WHAT THIS CAN AND CANNOT DISTINGUISH ────────────────────────────────────

 The consequence of not reading is that geometry is the ONLY signal available.
 A wide, roughly plate-shaped run of text is masked whether it is a plate, a
 shop sign, a book spine, or a wordmark printed across the front of a garment.
 In a wardrobe photograph the last of those is not hypothetical, and masking it
 blacks out part of the very garment the app exists to analyze. That is the
 accepted trade: this is a privacy boundary, so it fails toward masking. The
 caller — not this file — decides whether a `no_plates` screen is a strong
 enough result to make a privacy claim on, and it must not report this as
 "license plates removed" when what actually happened is "wide text regions
 were blacked out".

 Equally: `no_plates` means "no region matched the plate GEOMETRY", never "this
 image contains no plate". Plates outside the aspect band (motorcycle/stacked
 formats), plates below the size floors, and plates rotated far enough that
 their axis-aligned box squares up are all misses. See
 NativePrivacyConstants for each threshold and its reasoning.

 ── COORDINATE SPACE ────────────────────────────────────────────────────────

 Vision reports normalized coordinates with the ORIGIN AT BOTTOM-LEFT. The rest
 of the masking pipeline — the normalizer, the redactor, the verifier — works in
 TOP-LEFT pixel space. The flip below is copied line-for-line from
 `IOSFaceDetector.detect`, which is the reference conversion for this pipeline,
 so that a plate box and a face box in the same photograph land in the same
 space. Getting this wrong does not produce a visible error; it produces a black
 rectangle over the wrong part of the picture while every status field still
 says success.

 ── ORIENTATION ─────────────────────────────────────────────────────────────

 The caller passes the already-orientation-normalized CGImage that
 `IOSImageDecoder` produced, so `.up` is a fact about the input rather than a
 default — exactly as in IOSFaceDetector and IOSPersonDetector. Re-applying an
 EXIF orientation here would rotate the coordinate space a second time.
 */

/// The face path introduced these two geometry types, and neither carries any
/// face-specific meaning: one is a pixel-space rectangle, the other a padded,
/// clamped, integer box. The plate path REUSES them rather than declaring
/// parallel types, because a second copy of the padding/clamping/rounding/IoU
/// arithmetic in IOSFaceBoxNormalizer is precisely how the two paths would
/// silently drift apart — and because IOSFaceRedactor and IOSOutputVerifier
/// already consume IOSNormalizedFaceBox. These aliases add no behaviour; they
/// exist so the plate call sites read honestly.
typealias IOSRegionRect = IOSFaceRect
typealias IOSNormalizedRegionBox = IOSNormalizedFaceBox

enum IOSPlateDetectionResult {
    case success(plates: [IOSRegionRect], durationMs: Int)
    case failure(errorCode: NativePrivacyErrorCode, reason: String)
}

struct IOSPlateDetector {
    /**
     Screen an image for plate-like text regions.

     WRAPPED IN AN AUTORELEASEPOOL for the same reason IOSPersonDetector is: the
     request handler and its observations are autoreleased objects, and this runs
     immediately after a full-resolution decode and immediately before a
     full-resolution redaction — the moment memory headroom is thinnest. The
     caller is an `AsyncFunction`, so it already executes off the JavaScript
     thread and no additional dispatch is introduced here.
     */
    static func detect(image: CGImage) async -> IOSPlateDetectionResult {
        return autoreleasepool { () -> IOSPlateDetectionResult in
            detectInPool(image: image)
        }
    }

    private static func detectInPool(image: CGImage) -> IOSPlateDetectionResult {
        let startedAt = Date()

        let imageWidth = CGFloat(image.width)
        let imageHeight = CGFloat(image.height)
        // Degenerate dimensions are a FAILURE, not an empty screen. Reporting
        // "no plates" for an image that could not be measured would hand the
        // caller a clean result it has no basis for.
        guard imageWidth > 0, imageHeight > 0 else {
            return .failure(
                errorCode: .invalidRegion,
                reason: "Cannot screen an image with non-positive dimensions: \(image.width)x\(image.height)."
            )
        }
        let imageArea = Double(imageWidth) * Double(imageHeight)

        let request = VNDetectTextRectanglesRequest()
        // Pinned for the same reason the face request pins its revision: an OS
        // update that changes the default revision would move every box this
        // heuristic is tuned against, and the thresholds would go stale without
        // a single line of this module changing.
        request.revision = VNDetectTextRectanglesRequestRevision1
        // No per-character geometry. See the file header: characters are the one
        // thing this path must never produce.
        request.reportCharacterBoxes = false

        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])

        do {
            try handler.perform([request])
        } catch {
            // Any Vision error is a failure. It is never converted into an empty
            // detection list: "the detector broke" and "there is nothing here"
            // are opposite facts, and only one of them is safe to act on.
            return .failure(
                errorCode: .detectionFailed,
                reason: "Vision text-rectangle detection failed: \(error.localizedDescription)"
            )
        }

        // The typed accessor, not `results as? [VNTextObservation]`. A nil
        // results array means Vision found nothing, but a failed cast of nil is
        // indistinguishable from a failed cast of the wrong type — the typed
        // property removes the ambiguity instead of guessing at it. This mirrors
        // IOSPersonDetector's `results ?? []` rather than the older face path.
        let observations = request.results ?? []

        var plates: [IOSRegionRect] = []
        for observation in observations {
            let box = observation.boundingBox
            guard box.origin.x.isFinite, box.origin.y.isFinite,
                  box.width.isFinite, box.height.isFinite else {
                continue
            }

            // Bottom-left normalized → top-left pixels. Mirrors
            // IOSFaceDetector.detect exactly; see the file header.
            let rawLeft = box.origin.x * imageWidth
            let rawTop = (1 - box.origin.y - box.height) * imageHeight
            let rawRight = rawLeft + box.width * imageWidth
            let rawBottom = rawTop + box.height * imageHeight

            let rawWidth = rawRight - rawLeft
            let rawHeight = rawBottom - rawTop
            guard rawWidth > 0, rawHeight > 0 else { continue }

            // THE HEURISTIC IS APPLIED TO THE RAW BOX, THE MASK TO THE CLAMPED
            // ONE. Vision's normalized boxes are inside 0..1 by construction, so
            // clamping is defensive against edge rounding rather than routine —
            // but where it does bite, the raw box is what describes the object
            // and the clamped box is what can actually be painted. Judging a
            // frame-clipped plate by its visible sliver would reject it for
            // being the wrong shape, which is the one direction of error this
            // boundary must not make.
            guard isPlateLike(width: rawWidth, height: rawHeight, imageWidth: imageWidth, imageArea: imageArea) else {
                continue
            }

            // Clamp each EDGE independently, then re-measure. Never clamp an
            // origin while keeping the original extent: that slides the region
            // instead of clipping it, and the mask lands next to the plate
            // rather than on it. Same lesson as IOSPersonDetector.flipY.
            let left = max(0, min(imageWidth, rawLeft))
            let top = max(0, min(imageHeight, rawTop))
            let right = max(0, min(imageWidth, rawRight))
            let bottom = max(0, min(imageHeight, rawBottom))
            guard right > left, bottom > top else { continue }

            plates.append(IOSRegionRect(left: left, top: top, right: right, bottom: bottom))
        }

        // Measured across `perform` AND the geometry filter. The filter is pure
        // arithmetic over at most a few dozen boxes, but it is part of what
        // screening costs the caller, so it is inside the number the caller is
        // shown rather than quietly outside it.
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        return .success(plates: plates, durationMs: durationMs)
    }

    /**
     The whole plate heuristic, in one place.

     Every threshold, and the reasoning behind each, lives in
     NativePrivacyConstants under "License-plate REGION screening". Nothing here
     is tuned inline — a magic number in this function would be a rule that no
     reviewer of the constants file could see.

     LIMITATION worth naming at the point of use: `boundingBox` is axis-aligned.
     A plate photographed at an angle produces a box wider and taller than the
     plate itself, which inflates the region (harmless — it over-masks) but also
     drags the measured aspect ratio toward 1:1. Far enough off-axis and a real
     plate squares up below the 2.0 floor and is missed entirely.
     */
    private static func isPlateLike(
        width: CGFloat,
        height: CGFloat,
        imageWidth: CGFloat,
        imageArea: Double
    ) -> Bool {
        guard width > 0, height > 0, imageWidth > 0, imageArea > 0 else { return false }

        let aspectRatio = Double(width) / Double(height)
        guard aspectRatio >= NativePrivacyConstants.plateMinAspectRatio,
              aspectRatio <= NativePrivacyConstants.plateMaxAspectRatio else {
            return false
        }

        guard Double(width) >= Double(NativePrivacyConstants.plateMinPixelWidth),
              Double(height) >= Double(NativePrivacyConstants.plateMinPixelHeight) else {
            return false
        }

        guard Double(width) / Double(imageWidth) >= NativePrivacyConstants.plateMinRelativeWidth else {
            return false
        }

        let relativeArea = (Double(width) * Double(height)) / imageArea
        guard relativeArea >= NativePrivacyConstants.plateMinRelativeArea else {
            return false
        }

        return true
    }
}
