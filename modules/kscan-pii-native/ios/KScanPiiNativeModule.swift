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
                    // No output artifact is written for this path (there is nothing
                    // to mask), so outputWidth/outputHeight/sanitizedUri stay nil —
                    // matching Android's equivalent branch, which omits the same
                    // three fields rather than mirroring inputWidth/inputHeight.
                    // outputChecksum intentionally still equals inputChecksum: the
                    // pixel data is provably unchanged even though no file exists.
                    return NativeFaceMaskResult(
                        status: .noFaces,
                        platform: "ios",
                        detectorImplementation: "apple_vision",
                        detectorVersion: NativePrivacyConstants.detectorVersionAppleVision,
                        sanitizerVersion: NativePrivacyConstants.sanitizerVersion,
                        inputWidth: inputWidth,
                        inputHeight: inputHeight,
                        outputWidth: nil,
                        outputHeight: nil,
                        facesDetected: 0,
                        facesAccepted: 0,
                        facesMasked: 0,
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
                        warnings: ["No faces detected."],
                        errorCode: nil,
                        failureReason: nil
                    )
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
}
