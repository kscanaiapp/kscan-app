import ExpoModulesCore
import Foundation
import UIKit

public class KScanPiiNativeModule: Module {
    public func definition() -> ModuleDefinition {
        Name(NativePrivacyConstants.moduleName)

        AsyncFunction("getPrivacyCapabilities") { () -> [String: Any] in
            return self.buildCapabilities().toDictionary()
        }

        AsyncFunction("detectAndMaskFaces") { (input: [String: Any]) -> [String: Any] in
            let startedAt = Date()
            do {
                let result = try await self.detectAndMaskFacesInternal(input, startedAt: startedAt)
                return result.toDictionary()
            } catch {
                return self.buildFailureResult(
                    errorCode: .internalError,
                    reason: "Unexpected internal error: \(error.localizedDescription)",
                    totalDurationMs: Int(Date().timeIntervalSince(startedAt) * 1000)
                ).toDictionary()
            }
        }

        AsyncFunction("cleanupSanitizedImage") { (uri: String) -> [String: Any] in
            return IOSCacheManager.cleanupUri(uri).toDictionary()
        }

        // ── License-plate REGION screening ──────────────────────────────────
        //
        // The same pipeline as face masking — decode, detect, normalize and pad,
        // redact, encode, re-decode and verify — with the face detector swapped
        // for a text-RECTANGLE detector plus a geometry heuristic. Every stage
        // after detection is the identical, already-audited code: the normalizer,
        // the redactor and the verifier are region-generic despite their names.
        //
        // It writes a derivative file exactly as face masking does, so unlike
        // person detection it DOES have a cleanup counterpart —
        // `cleanupSanitizedImage` accepts a plate output without changes, since
        // ownership is decided by the cache namespace and not by which capability
        // produced the file.
        AsyncFunction("getPlateCapabilities") { () -> [String: Any] in
            return self.buildPlateCapabilities().toDictionary()
        }

        AsyncFunction("detectAndMaskPlates") { (input: [String: Any]) -> [String: Any] in
            let startedAt = Date()
            do {
                let result = try await self.detectAndMaskPlatesInternal(input, startedAt: startedAt)
                return result.toDictionary()
            } catch {
                return self.buildPlateFailureResult(
                    errorCode: .internalError,
                    reason: "Unexpected internal error: \(error.localizedDescription)",
                    totalDurationMs: Int(Date().timeIntervalSince(startedAt) * 1000)
                ).toDictionary()
            }
        }

        // ── Person / body-region detection (Build 2.5 Step 3) ───────────────
        //
        // Read-only: decodes, measures, returns geometry. Writes no derivative
        // file and modifies no input, so unlike face masking there is no
        // cleanup counterpart and no sanitized URI to track.
        //
        // `AsyncFunction` already dispatches off the JavaScript thread, and
        // Vision performs its own work on a background queue, so no additional
        // dispatch is introduced here.
        AsyncFunction("getExtractionCapabilities") { () -> [String: Any] in
            return NativeExtractionCapabilities(personDetectionSupported: true).toDictionary()
        }

        AsyncFunction("detectPersonRegions") { (input: [String: Any]) -> [String: Any] in
            let startedAt = Date()
            return self.detectPersonRegionsInternal(input, startedAt: startedAt).toDictionary()
        }
    }

    private func detectPersonRegionsInternal(
        _ input: [String: Any],
        startedAt: Date
    ) -> NativePersonDetectionResult {
        guard let imageUri = input["imageUri"] as? String, !imageUri.isEmpty else {
            return NativePersonDetectionResult(
                status: .failed,
                totalDurationMs: durationSince(startedAt),
                warnings: ["Missing image."],
                errorCode: .invalidInput,
                failureReason: "Missing or empty imageUri."
            )
        }

        switch IOSImageDecoder.decodeFileUri(imageUri) {
        case .failure(let errorCode, let reason):
            return NativePersonDetectionResult(
                status: .failed,
                totalDurationMs: durationSince(startedAt),
                warnings: ["Could not decode the source image."],
                errorCode: errorCode,
                failureReason: reason
            )

        case .success(let image, _, let width, let height):
            switch IOSPersonDetector.detect(cgImage: image) {
            case .failure(let errorCode, let reason):
                return NativePersonDetectionResult(
                    status: .failed,
                    inputWidth: width,
                    inputHeight: height,
                    totalDurationMs: durationSince(startedAt),
                    warnings: ["Person detection failed."],
                    errorCode: errorCode,
                    failureReason: reason
                )

            case .success(let persons, let detectionDurationMs):
                // `noPerson` is a distinct status from `failed` on purpose: one
                // is a fact about the photograph the user can act on, the other
                // is a fault they cannot.
                return NativePersonDetectionResult(
                    status: persons.isEmpty ? .noPerson : .success,
                    persons: persons,
                    inputWidth: width,
                    inputHeight: height,
                    detectionDurationMs: detectionDurationMs,
                    totalDurationMs: durationSince(startedAt),
                    warnings: persons.isEmpty ? ["No person detected."] : []
                )
            }
        }
    }

    private func buildCapabilities() -> NativePrivacyCapabilities {
        return NativePrivacyCapabilities(
            supported: true,
            platform: "ios",
            detectorImplementation: "apple_vision",
            acceptedUriSchemes: [NativePrivacyConstants.acceptedUriScheme],
            acceptedMimeTypes: Array(NativePrivacyConstants.acceptedMimeTypes),
            outputMimeType: NativePrivacyConstants.outputMimeType,
            maxWidth: NativePrivacyConstants.maxWidth,
            maxHeight: NativePrivacyConstants.maxHeight,
            maxPixels: NativePrivacyConstants.maxPixels,
            sanitizerVersion: NativePrivacyConstants.sanitizerVersion
        )
    }

    private func buildPlateCapabilities() -> NativePlateCapabilities {
        return NativePlateCapabilities(
            supported: true,
            platform: "ios",
            detectorImplementation: NativePrivacyConstants.plateDetectorImplementation,
            detectorVersion: NativePrivacyConstants.detectorVersionVisionTextRectangles,
            sanitizerVersion: NativePrivacyConstants.plateSanitizerVersion,
            // Constant false, and reported rather than assumed. See
            // NativePlateMaskResult.ocrPerformed.
            ocrPerformed: false,
            // The input contract is the module's, not the capability's: the same
            // decoder, the same schemes, the same size ceilings, the same output
            // format. Reading these from the shared constants is what keeps the
            // two capabilities from drifting into two different contracts.
            acceptedUriSchemes: [NativePrivacyConstants.acceptedUriScheme],
            acceptedMimeTypes: Array(NativePrivacyConstants.acceptedMimeTypes),
            outputMimeType: NativePrivacyConstants.outputMimeType,
            maxWidth: NativePrivacyConstants.maxWidth,
            maxHeight: NativePrivacyConstants.maxHeight,
            maxPixels: NativePrivacyConstants.maxPixels,
            defaultPaddingRatio: NativePrivacyConstants.defaultPlatePaddingRatio,
            minPaddingRatio: NativePrivacyConstants.minPaddingRatio,
            maxPaddingRatio: NativePrivacyConstants.maxPaddingRatio
        )
    }

    private func detectAndMaskFacesInternal(_ input: [String: Any], startedAt: Date) async throws -> NativeFaceMaskResult {
        guard let imageUri = input["imageUri"] as? String, !imageUri.isEmpty else {
            return buildFailureResult(
                errorCode: .invalidInput,
                reason: "Missing or empty imageUri.",
                totalDurationMs: durationSince(startedAt)
            )
        }

        let paddingRatio = input["paddingRatio"] as? Double ?? NativePrivacyConstants.defaultPaddingRatio
        if paddingRatio < NativePrivacyConstants.minPaddingRatio || paddingRatio > NativePrivacyConstants.maxPaddingRatio {
            return buildFailureResult(
                errorCode: .invalidInput,
                reason: "paddingRatio must be between \(NativePrivacyConstants.minPaddingRatio) and \(NativePrivacyConstants.maxPaddingRatio).",
                totalDurationMs: durationSince(startedAt)
            )
        }

        let decodeResult = IOSImageDecoder.decodeFileUri(imageUri)
        switch decodeResult {
        case .failure(let errorCode, let reason):
            return buildFailureResult(errorCode: errorCode, reason: reason, totalDurationMs: durationSince(startedAt))
        case .success(let sourceImage, _, let inputWidth, let inputHeight):
            let inputChecksum = computeCGImageChecksum(sourceImage)

            let detectionResult = await IOSFaceDetector.detect(image: sourceImage)
            switch detectionResult {
            case .failure(let errorCode, let reason):
                return buildFailureResult(
                    errorCode: errorCode,
                    reason: reason,
                    inputWidth: inputWidth,
                    inputHeight: inputHeight,
                    inputChecksum: inputChecksum,
                    totalDurationMs: durationSince(startedAt)
                )
            case .success(let faces, let detectionDurationMs):
                if faces.isEmpty {
                    // B2A: a face-free image STILL produces a sanitized artifact.
                    //
                    // "Sanitized" means decoded and re-encoded from pixels — which
                    // is what actually drops EXIF/GPS/camera metadata — and then
                    // verified. Masking is orthogonal: a clothing-only photo needs
                    // no redaction but absolutely still needs its metadata gone.
                    //
                    // The previous form returned sanitizedUri: nil here, which was
                    // unreachable while the plate gate was closed. With plate
                    // screening live it would have blocked every face-free image
                    // at the boundary's `if (!faceResult.sanitizedUri)` guard —
                    // i.e. nearly every Closet garment photo.
                    //
                    // Regions are empty, so verification is a dimension/decode
                    // check; pixelsChanged stays false because nothing was drawn.
                    let encodingStartedAt = Date()
                    let outputFile = IOSCacheManager.createOutputFile()
                    let encodeSuccess = writePNG(sourceImage, to: outputFile)
                    let encodingDurationMs = Int(Date().timeIntervalSince(encodingStartedAt) * 1000)

                    guard encodeSuccess else {
                        IOSCacheManager.deleteUnverifiableOutput(outputFile)
                        return buildFailureResult(
                            errorCode: .encodingFailed,
                            reason: "Failed to encode and write PNG output to \(outputFile.path).",
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            inputChecksum: inputChecksum,
                            totalDurationMs: durationSince(startedAt)
                        )
                    }

                    let noFaceVerification = IOSOutputVerifier.verify(
                        outputFile: outputFile,
                        expectedWidth: inputWidth,
                        expectedHeight: inputHeight,
                        regions: []
                    )

                    switch noFaceVerification {
                    case .failure(let errorCode, let reason):
                        IOSCacheManager.deleteUnverifiableOutput(outputFile)
                        return buildFailureResult(
                            errorCode: errorCode,
                            reason: reason,
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            inputChecksum: inputChecksum,
                            totalDurationMs: durationSince(startedAt)
                        )
                    case .success(let outputWidth, let outputHeight, let outputChecksum, let verificationDurationMs):
                    return NativeFaceMaskResult(
                        status: .noFaces,
                        platform: "ios",
                        detectorImplementation: "apple_vision",
                        detectorVersion: NativePrivacyConstants.detectorVersionAppleVision,
                        sanitizerVersion: NativePrivacyConstants.sanitizerVersion,
                        inputWidth: inputWidth,
                        inputHeight: inputHeight,
                        outputWidth: outputWidth,
                        outputHeight: outputHeight,
                        facesDetected: 0,
                        facesAccepted: 0,
                        facesMasked: 0,
                        regionsChanged: 0,
                        regionsAlreadyRedacted: 0,
                        pixelsChanged: false,
                        sanitizedUri: "file://\(outputFile.path)",
                        inputChecksum: inputChecksum,
                        outputChecksum: outputChecksum,
                        checksumAlgorithm: NativePrivacyConstants.checksumAlgorithm,
                        detectionDurationMs: detectionDurationMs,
                        maskingDurationMs: nil,
                        encodingDurationMs: encodingDurationMs,
                        verificationDurationMs: verificationDurationMs,
                        totalDurationMs: durationSince(startedAt),
                        warnings: ["No faces detected."],
                        errorCode: nil,
                        failureReason: nil
                    )
                    }
                }

                let normalizedBoxes = IOSFaceBoxNormalizer.normalizeAndPad(
                    faces: faces,
                    imageWidth: inputWidth,
                    imageHeight: inputHeight,
                    paddingRatio: paddingRatio
                )

                if normalizedBoxes.isEmpty {
                    return buildFailureResult(
                        errorCode: .invalidRegion,
                        reason: "Faces were detected but all regions were invalid after normalization.",
                        inputWidth: inputWidth,
                        inputHeight: inputHeight,
                        inputChecksum: inputChecksum,
                        facesDetected: faces.count,
                        totalDurationMs: durationSince(startedAt)
                    )
                }

                let redactionResult = IOSFaceRedactor.redactRegions(image: sourceImage, regions: normalizedBoxes)
                switch redactionResult {
                case .failure(let errorCode, let reason):
                    return buildFailureResult(
                        errorCode: errorCode,
                        reason: reason,
                        inputWidth: inputWidth,
                        inputHeight: inputHeight,
                        inputChecksum: inputChecksum,
                        facesDetected: faces.count,
                        facesAccepted: normalizedBoxes.count,
                        totalDurationMs: durationSince(startedAt)
                    )
                case .success(let outputImage, let regionsChanged, let regionsAlreadyRedacted, let pixelsChanged, let maskingDurationMs):
                    guard outputImage.width == inputWidth, outputImage.height == inputHeight else {
                        return buildFailureResult(
                            errorCode: .maskingFailed,
                            reason: "Redacted output dimensions do not match input dimensions.",
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            inputChecksum: inputChecksum,
                            facesDetected: faces.count,
                            facesAccepted: normalizedBoxes.count,
                            totalDurationMs: durationSince(startedAt)
                        )
                    }

                    let encodingStartedAt = Date()
                    let outputFile = IOSCacheManager.createOutputFile()
                    let encodeSuccess = writePNG(outputImage, to: outputFile)
                    let encodingDurationMs = Int(Date().timeIntervalSince(encodingStartedAt) * 1000)

                    guard encodeSuccess else {
                        IOSCacheManager.deleteUnverifiableOutput(outputFile)
                        return buildFailureResult(
                            errorCode: .encodingFailed,
                            reason: "Failed to encode and write PNG output to \(outputFile.path).",
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            inputChecksum: inputChecksum,
                            facesDetected: faces.count,
                            facesAccepted: normalizedBoxes.count,
                            pixelsChanged: pixelsChanged,
                            totalDurationMs: durationSince(startedAt)
                        )
                    }

                    let verificationResult = IOSOutputVerifier.verify(
                        outputFile: outputFile,
                        expectedWidth: inputWidth,
                        expectedHeight: inputHeight,
                        regions: normalizedBoxes
                    )

                    switch verificationResult {
                    case .failure(let errorCode, let reason):
                        IOSCacheManager.deleteUnverifiableOutput(outputFile)
                        return buildFailureResult(
                            errorCode: errorCode,
                            reason: reason,
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            inputChecksum: inputChecksum,
                            facesDetected: faces.count,
                            facesAccepted: normalizedBoxes.count,
                            facesMasked: normalizedBoxes.count,
                            pixelsChanged: pixelsChanged,
                            totalDurationMs: durationSince(startedAt)
                        )
                    case .success(let outputWidth, let outputHeight, let outputChecksum, let verificationDurationMs):
                        return NativeFaceMaskResult(
                            status: .success,
                            platform: "ios",
                            detectorImplementation: "apple_vision",
                            detectorVersion: NativePrivacyConstants.detectorVersionAppleVision,
                            sanitizerVersion: NativePrivacyConstants.sanitizerVersion,
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            outputWidth: outputWidth,
                            outputHeight: outputHeight,
                            facesDetected: faces.count,
                            facesAccepted: normalizedBoxes.count,
                            facesMasked: normalizedBoxes.count,
                            regionsChanged: regionsChanged,
                            regionsAlreadyRedacted: regionsAlreadyRedacted,
                            pixelsChanged: pixelsChanged,
                            sanitizedUri: outputFile.absoluteString,
                            inputChecksum: inputChecksum,
                            outputChecksum: outputChecksum,
                            checksumAlgorithm: NativePrivacyConstants.checksumAlgorithm,
                            detectionDurationMs: detectionDurationMs,
                            maskingDurationMs: maskingDurationMs,
                            encodingDurationMs: encodingDurationMs,
                            verificationDurationMs: verificationDurationMs,
                            totalDurationMs: durationSince(startedAt),
                            warnings: [],
                            errorCode: nil,
                            failureReason: nil
                        )
                    }
                }
            }
        }
    }

    /**
     Plate screening and masking. Mirrors detectAndMaskFacesInternal stage for
     stage; the differences are all deliberate and listed here so a reviewer does
     not have to diff two 200-line functions to find them:

       1. The detector is IOSPlateDetector (text rectangles + geometry), not
          IOSFaceDetector.
       2. The default padding ratio is the plate one (0.25, not 0.15). The BOUNDS
          a caller-supplied ratio is validated against are shared, because they
          are a property of the redactor, not of what is being redacted.
       3. The result type is NativePlateMaskResult, so the counters are named for
          what was actually counted.

     Everything from normalization onward is the identical audited code path.

     FAIL-CLOSED: there is no branch below that returns the caller's original URI,
     and no branch that returns a `success` status without a verified output file.
     Every error becomes `.failed` with a typed code from the module's existing
     NativePrivacyErrorCode vocabulary — no plate-specific code was added, because
     every failure mode here is one the face path already named.
     */
    private func detectAndMaskPlatesInternal(_ input: [String: Any], startedAt: Date) async throws -> NativePlateMaskResult {
        guard let imageUri = input["imageUri"] as? String, !imageUri.isEmpty else {
            return buildPlateFailureResult(
                errorCode: .invalidInput,
                reason: "Missing or empty imageUri.",
                totalDurationMs: durationSince(startedAt)
            )
        }

        let paddingRatio = input["paddingRatio"] as? Double ?? NativePrivacyConstants.defaultPlatePaddingRatio
        if paddingRatio < NativePrivacyConstants.minPaddingRatio || paddingRatio > NativePrivacyConstants.maxPaddingRatio {
            return buildPlateFailureResult(
                errorCode: .invalidInput,
                reason: "paddingRatio must be between \(NativePrivacyConstants.minPaddingRatio) and \(NativePrivacyConstants.maxPaddingRatio).",
                totalDurationMs: durationSince(startedAt)
            )
        }

        let decodeResult = IOSImageDecoder.decodeFileUri(imageUri)
        switch decodeResult {
        case .failure(let errorCode, let reason):
            return buildPlateFailureResult(errorCode: errorCode, reason: reason, totalDurationMs: durationSince(startedAt))
        case .success(let sourceImage, _, let inputWidth, let inputHeight):
            let inputChecksum = computeCGImageChecksum(sourceImage)

            let detectionResult = await IOSPlateDetector.detect(image: sourceImage)
            switch detectionResult {
            case .failure(let errorCode, let reason):
                return buildPlateFailureResult(
                    errorCode: errorCode,
                    reason: reason,
                    inputWidth: inputWidth,
                    inputHeight: inputHeight,
                    inputChecksum: inputChecksum,
                    totalDurationMs: durationSince(startedAt)
                )
            case .success(let plates, let detectionDurationMs):
                if plates.isEmpty {
                    // Mirrors the face path's `.noFaces` branch exactly: no
                    // output artifact is written because there is nothing to
                    // mask, so outputWidth/outputHeight/sanitizedUri stay nil and
                    // outputChecksum equals inputChecksum — the pixels are
                    // provably unchanged even though no file exists.
                    //
                    // This is NOT the unmasked image being handed back as a
                    // success: no URI is returned at all, and the status is a
                    // distinct one the caller must handle on its own terms. The
                    // warning says what was actually established, because
                    // "no_plates" is a statement about the heuristic and not
                    // about the photograph.
                    return NativePlateMaskResult(
                        status: .noPlates,
                        platform: "ios",
                        detectorImplementation: NativePrivacyConstants.plateDetectorImplementation,
                        detectorVersion: NativePrivacyConstants.detectorVersionVisionTextRectangles,
                        sanitizerVersion: NativePrivacyConstants.plateSanitizerVersion,
                        ocrPerformed: false,
                        inputWidth: inputWidth,
                        inputHeight: inputHeight,
                        outputWidth: nil,
                        outputHeight: nil,
                        platesDetected: 0,
                        platesAccepted: 0,
                        platesMasked: 0,
                        regionsChanged: 0,
                        regionsAlreadyRedacted: 0,
                        pixelsChanged: false,
                        sanitizedUri: nil,
                        inputChecksum: inputChecksum,
                        outputChecksum: inputChecksum,
                        checksumAlgorithm: NativePrivacyConstants.checksumAlgorithm,
                        detectionDurationMs: detectionDurationMs,
                        maskingDurationMs: nil,
                        encodingDurationMs: nil,
                        verificationDurationMs: nil,
                        totalDurationMs: durationSince(startedAt),
                        warnings: ["No plate-like text regions detected. This is a geometry screen, not a guarantee that the image contains no plate."],
                        errorCode: nil,
                        failureReason: nil
                    )
                }

                // The `faces:` label is the normalizer's, not a claim about what
                // these boxes are. IOSFaceBoxNormalizer pads, clamps, rounds and
                // IoU-deduplicates pixel rectangles; none of that is
                // face-specific, and reusing it is what keeps plate regions and
                // face regions landing on identical pixel boundaries.
                let normalizedBoxes: [IOSNormalizedRegionBox] = IOSFaceBoxNormalizer.normalizeAndPad(
                    faces: plates,
                    imageWidth: inputWidth,
                    imageHeight: inputHeight,
                    paddingRatio: paddingRatio
                )

                if normalizedBoxes.isEmpty {
                    return buildPlateFailureResult(
                        errorCode: .invalidRegion,
                        reason: "Plate regions were detected but all were invalid after normalization.",
                        inputWidth: inputWidth,
                        inputHeight: inputHeight,
                        inputChecksum: inputChecksum,
                        platesDetected: plates.count,
                        totalDurationMs: durationSince(startedAt)
                    )
                }

                let redactionResult = IOSFaceRedactor.redactRegions(image: sourceImage, regions: normalizedBoxes)
                switch redactionResult {
                case .failure(let errorCode, let reason):
                    return buildPlateFailureResult(
                        errorCode: errorCode,
                        reason: reason,
                        inputWidth: inputWidth,
                        inputHeight: inputHeight,
                        inputChecksum: inputChecksum,
                        platesDetected: plates.count,
                        platesAccepted: normalizedBoxes.count,
                        totalDurationMs: durationSince(startedAt)
                    )
                case .success(let outputImage, let regionsChanged, let regionsAlreadyRedacted, let pixelsChanged, let maskingDurationMs):
                    guard outputImage.width == inputWidth, outputImage.height == inputHeight else {
                        return buildPlateFailureResult(
                            errorCode: .maskingFailed,
                            reason: "Redacted output dimensions do not match input dimensions.",
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            inputChecksum: inputChecksum,
                            platesDetected: plates.count,
                            platesAccepted: normalizedBoxes.count,
                            totalDurationMs: durationSince(startedAt)
                        )
                    }

                    let encodingStartedAt = Date()
                    let outputFile = IOSCacheManager.createOutputFile()
                    let encodeSuccess = writePNG(outputImage, to: outputFile)
                    let encodingDurationMs = Int(Date().timeIntervalSince(encodingStartedAt) * 1000)

                    guard encodeSuccess else {
                        IOSCacheManager.deleteUnverifiableOutput(outputFile)
                        return buildPlateFailureResult(
                            errorCode: .encodingFailed,
                            reason: "Failed to encode and write PNG output to \(outputFile.path).",
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            inputChecksum: inputChecksum,
                            platesDetected: plates.count,
                            platesAccepted: normalizedBoxes.count,
                            pixelsChanged: pixelsChanged,
                            totalDurationMs: durationSince(startedAt)
                        )
                    }

                    let verificationResult = IOSOutputVerifier.verify(
                        outputFile: outputFile,
                        expectedWidth: inputWidth,
                        expectedHeight: inputHeight,
                        regions: normalizedBoxes
                    )

                    switch verificationResult {
                    case .failure(let errorCode, let reason):
                        // The unverifiable artifact is DELETED before returning.
                        // A half-masked file left in the cache is worse than no
                        // file: the URI would still be dereferenceable by
                        // anything that happened to hold it.
                        IOSCacheManager.deleteUnverifiableOutput(outputFile)
                        return buildPlateFailureResult(
                            errorCode: errorCode,
                            reason: reason,
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            inputChecksum: inputChecksum,
                            platesDetected: plates.count,
                            platesAccepted: normalizedBoxes.count,
                            platesMasked: normalizedBoxes.count,
                            pixelsChanged: pixelsChanged,
                            totalDurationMs: durationSince(startedAt)
                        )
                    case .success(let outputWidth, let outputHeight, let outputChecksum, let verificationDurationMs):
                        return NativePlateMaskResult(
                            status: .success,
                            platform: "ios",
                            detectorImplementation: NativePrivacyConstants.plateDetectorImplementation,
                            detectorVersion: NativePrivacyConstants.detectorVersionVisionTextRectangles,
                            sanitizerVersion: NativePrivacyConstants.plateSanitizerVersion,
                            ocrPerformed: false,
                            inputWidth: inputWidth,
                            inputHeight: inputHeight,
                            outputWidth: outputWidth,
                            outputHeight: outputHeight,
                            platesDetected: plates.count,
                            platesAccepted: normalizedBoxes.count,
                            platesMasked: normalizedBoxes.count,
                            regionsChanged: regionsChanged,
                            regionsAlreadyRedacted: regionsAlreadyRedacted,
                            pixelsChanged: pixelsChanged,
                            sanitizedUri: outputFile.absoluteString,
                            inputChecksum: inputChecksum,
                            outputChecksum: outputChecksum,
                            checksumAlgorithm: NativePrivacyConstants.checksumAlgorithm,
                            detectionDurationMs: detectionDurationMs,
                            maskingDurationMs: maskingDurationMs,
                            encodingDurationMs: encodingDurationMs,
                            verificationDurationMs: verificationDurationMs,
                            totalDurationMs: durationSince(startedAt),
                            warnings: [],
                            errorCode: nil,
                            failureReason: nil
                        )
                    }
                }
            }
        }
    }

    private func writePNG(_ image: CGImage, to url: URL) -> Bool {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            return false
        }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination)
    }

    private func computeCGImageChecksum(_ image: CGImage) -> String {
        guard let pixels = IOSFaceRedactor.pixelsFromCGImage(image) else {
            return ""
        }
        return IOSOutputVerifier.checksumBuffer(pixels)
    }

    private func durationSince(_ startedAt: Date) -> Int {
        return Int(Date().timeIntervalSince(startedAt) * 1000)
    }

    private func buildFailureResult(
        errorCode: NativePrivacyErrorCode,
        reason: String,
        inputWidth: Int? = nil,
        inputHeight: Int? = nil,
        inputChecksum: String? = nil,
        facesDetected: Int = 0,
        facesAccepted: Int = 0,
        facesMasked: Int = 0,
        pixelsChanged: Bool = false,
        totalDurationMs: Int? = nil
    ) -> NativeFaceMaskResult {
        // No failure path on either platform reports partial per-stage timings or
        // an output artifact — matching Android's buildFailureResult exactly, even
        // for failures (like .invalidRegion) that occur after detection already
        // measured a real duration. Only the aggregate totalDurationMs survives
        // into a failure result; the rest stay nil rather than fabricating or
        // silently promoting a partial measurement to a final one.
        return NativeFaceMaskResult(
            status: .failed,
            platform: "ios",
            detectorImplementation: "apple_vision",
            detectorVersion: NativePrivacyConstants.detectorVersionAppleVision,
            sanitizerVersion: NativePrivacyConstants.sanitizerVersion,
            inputWidth: inputWidth,
            inputHeight: inputHeight,
            outputWidth: nil,
            outputHeight: nil,
            facesDetected: facesDetected,
            facesAccepted: facesAccepted,
            facesMasked: facesMasked,
            regionsChanged: 0,
            regionsAlreadyRedacted: 0,
            pixelsChanged: pixelsChanged,
            sanitizedUri: nil,
            inputChecksum: inputChecksum,
            outputChecksum: nil,
            checksumAlgorithm: nil,
            detectionDurationMs: nil,
            maskingDurationMs: nil,
            encodingDurationMs: nil,
            verificationDurationMs: nil,
            totalDurationMs: totalDurationMs,
            warnings: [reason],
            errorCode: errorCode,
            failureReason: reason
        )
    }

    private func buildPlateFailureResult(
        errorCode: NativePrivacyErrorCode,
        reason: String,
        inputWidth: Int? = nil,
        inputHeight: Int? = nil,
        inputChecksum: String? = nil,
        platesDetected: Int = 0,
        platesAccepted: Int = 0,
        platesMasked: Int = 0,
        pixelsChanged: Bool = false,
        totalDurationMs: Int? = nil
    ) -> NativePlateMaskResult {
        // Same discipline as buildFailureResult: no failure reports per-stage
        // timings and none reports an output artifact, even where a stage did
        // complete and did measure a real duration. Only the aggregate
        // totalDurationMs survives. A partial measurement promoted to a final one
        // reads, downstream, as a stage that succeeded.
        //
        // sanitizedUri is nil on EVERY path through here. That is the fail-closed
        // guarantee in one line: a caller cannot receive an image URI from this
        // function, so it cannot mistake an unmasked original for a masked
        // derivative no matter which error occurred.
        return NativePlateMaskResult(
            status: .failed,
            platform: "ios",
            detectorImplementation: NativePrivacyConstants.plateDetectorImplementation,
            detectorVersion: NativePrivacyConstants.detectorVersionVisionTextRectangles,
            sanitizerVersion: NativePrivacyConstants.plateSanitizerVersion,
            ocrPerformed: false,
            inputWidth: inputWidth,
            inputHeight: inputHeight,
            outputWidth: nil,
            outputHeight: nil,
            platesDetected: platesDetected,
            platesAccepted: platesAccepted,
            platesMasked: platesMasked,
            regionsChanged: 0,
            regionsAlreadyRedacted: 0,
            pixelsChanged: pixelsChanged,
            sanitizedUri: nil,
            inputChecksum: inputChecksum,
            outputChecksum: nil,
            checksumAlgorithm: nil,
            detectionDurationMs: nil,
            maskingDurationMs: nil,
            encodingDurationMs: nil,
            verificationDurationMs: nil,
            totalDurationMs: totalDurationMs,
            warnings: [reason],
            errorCode: errorCode,
            failureReason: reason
        )
    }
}
