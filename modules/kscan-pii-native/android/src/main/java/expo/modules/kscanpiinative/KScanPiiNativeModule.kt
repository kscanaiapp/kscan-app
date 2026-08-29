package expo.modules.kscanpiinative

import android.graphics.Bitmap
import android.os.Bundle
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.FileOutputStream

class KScanPiiNativeModule : Module() {
    private val moduleScope = CoroutineScope(Dispatchers.Main)

    override fun definition() = ModuleDefinition {
        Name(NativePrivacyConstants.MODULE_NAME)

        AsyncFunction("getPrivacyCapabilities") { promise: Promise ->
            promise.resolve(buildCapabilities().toBundle())
        }

        AsyncFunction("detectAndMaskFaces") { input: NativeFaceMaskInputRecord, promise: Promise ->
            val startedAt = System.currentTimeMillis()
            moduleScope.launch {
                try {
                    val result = withContext(Dispatchers.IO) {
                        detectAndMaskFacesInternal(input, startedAt)
                    }
                    promise.resolve(result.toBundle())
                } catch (e: Exception) {
                    promise.resolve(
                        buildFailureResult(
                            errorCode = NativePrivacyErrorCode.INTERNAL_ERROR,
                            reason = "Unexpected internal error: ${e.message}",
                            totalDurationMs = System.currentTimeMillis() - startedAt,
                        ).toBundle(),
                    )
                }
            }
        }

        // ── License-plate masking (Build 34, closet media privacy) ──────────
        //
        // The same destructive pipeline as detectAndMaskFaces, asked a
        // different question about which regions to destroy. It reuses the
        // decoder, the box normalizer, the redactor, the cache manager and the
        // output verifier verbatim; only region SELECTION differs.
        //
        // Dispatchers.IO for the same reason the face path uses it: the wall
        // clock here is dominated by decoding a file and writing a PNG, not by
        // inference.
        AsyncFunction("getPlateCapabilities") { promise: Promise ->
            promise.resolve(buildPlateCapabilities().toBundle())
        }

        AsyncFunction("detectAndMaskPlates") { input: NativePlateMaskInputRecord, promise: Promise ->
            val startedAt = System.currentTimeMillis()
            moduleScope.launch {
                try {
                    val result = withContext(Dispatchers.IO) {
                        detectAndMaskPlatesInternal(input, startedAt)
                    }
                    promise.resolve(result.toBundle())
                } catch (e: Exception) {
                    promise.resolve(
                        buildPlateFailureResult(
                            errorCode = NativePrivacyErrorCode.INTERNAL_ERROR,
                            reason = "Unexpected internal error: ${e.message}",
                            totalDurationMs = System.currentTimeMillis() - startedAt,
                        ).toBundle(),
                    )
                }
            }
        }

        // ── Person / body-region detection (Build 2.5 Step 3) ───────────────
        //
        // Read-only: decodes, measures, and returns geometry. Writes no file
        // and modifies no input, so there is no cleanup counterpart.
        //
        // Runs on Dispatchers.Default rather than Dispatchers.IO — pose
        // inference is CPU work, not blocking I/O, and it must not occupy an
        // IO thread that the rest of the app needs. Either way it is off the
        // JavaScript thread.
        AsyncFunction("getExtractionCapabilities") { promise: Promise ->
            promise.resolve(NativeExtractionCapabilities(personDetectionSupported = true).toBundle())
        }

        AsyncFunction("detectPersonRegions") { input: NativePersonDetectionInputRecord, promise: Promise ->
            val startedAt = System.currentTimeMillis()
            moduleScope.launch {
                try {
                    val result = withContext(Dispatchers.Default) {
                        detectPersonRegionsInternal(input, startedAt)
                    }
                    promise.resolve(result.toBundle())
                } catch (e: Exception) {
                    promise.resolve(
                        NativePersonDetectionResult(
                            status = NativeExtractionStatus.FAILED,
                            errorCode = NativePrivacyErrorCode.INTERNAL_ERROR,
                            failureReason = "Unexpected internal error: ${e.message}",
                            totalDurationMs = System.currentTimeMillis() - startedAt,
                            warnings = listOf("Person detection failed."),
                        ).toBundle(),
                    )
                }
            }
        }

        AsyncFunction("cleanupSanitizedImage") { uri: String, promise: Promise ->
            val context = appContext.reactContext ?: run {
                promise.resolve(
                    NativeCleanupResult(
                        deleted = false,
                        rejected = false,
                        warnings = listOf("React context is not available."),
                    ).toBundle(),
                )
                return@AsyncFunction
            }
            promise.resolve(AndroidCacheManager.cleanupUri(context, uri).toBundle())
        }

        OnDestroy {
            moduleScope.cancel()
        }
    }

    private fun buildCapabilities(): NativePrivacyCapabilities {
        return NativePrivacyCapabilities(
            supported = true,
            platform = "android",
            detectorImplementation = "mlkit_bundled",
            acceptedUriSchemes = listOf(NativePrivacyConstants.ACCEPTED_URI_SCHEME),
            acceptedMimeTypes = NativePrivacyConstants.ACCEPTED_MIME_TYPES.toList(),
            outputMimeType = NativePrivacyConstants.OUTPUT_MIME_TYPE,
            maxWidth = NativePrivacyConstants.MAX_WIDTH,
            maxHeight = NativePrivacyConstants.MAX_HEIGHT,
            maxPixels = NativePrivacyConstants.MAX_PIXELS,
            sanitizerVersion = NativePrivacyConstants.SANITIZER_VERSION,
        )
    }

    private suspend fun detectAndMaskFacesInternal(
        input: NativeFaceMaskInputRecord,
        startedAt: Long,
    ): NativeFaceMaskResult {
        val imageUri = input.imageUri
        if (imageUri.isBlank()) {
            return buildFailureResult(
                errorCode = NativePrivacyErrorCode.INVALID_INPUT,
                reason = "Missing or empty imageUri.",
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val paddingRatio = input.paddingRatio ?: NativePrivacyConstants.DEFAULT_PADDING_RATIO

        if (paddingRatio < NativePrivacyConstants.MIN_PADDING_RATIO ||
            paddingRatio > NativePrivacyConstants.MAX_PADDING_RATIO
        ) {
            return buildFailureResult(
                errorCode = NativePrivacyErrorCode.INVALID_INPUT,
                reason = "paddingRatio must be between ${NativePrivacyConstants.MIN_PADDING_RATIO} and ${NativePrivacyConstants.MAX_PADDING_RATIO}.",
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val decodeResult = AndroidImageDecoder.decodeFileUri(imageUri)
        if (decodeResult is DecodeResult.Failure) {
            return buildFailureResult(
                errorCode = decodeResult.errorCode,
                reason = decodeResult.reason,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val source = (decodeResult as DecodeResult.Success).bitmap
        val inputWidth = source.width
        val inputHeight = source.height
        val inputChecksum = computeBitmapChecksum(source)

        val detectionResult = AndroidFaceDetector.detect(source)
        if (detectionResult is DetectionResult.Failure) {
            source.recycle()
            return buildFailureResult(
                errorCode = detectionResult.errorCode,
                reason = detectionResult.reason,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val faces = (detectionResult as DetectionResult.Success).faces
        if (faces.isEmpty()) {
            source.recycle()
            return NativeFaceMaskResult(
                status = NativePrivacyStatus.NO_FACES,
                platform = "android",
                detectorImplementation = "mlkit_bundled",
                detectorVersion = NativePrivacyConstants.DETECTOR_VERSION_MLKIT,
                sanitizerVersion = NativePrivacyConstants.SANITIZER_VERSION,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                facesDetected = 0,
                facesAccepted = 0,
                facesMasked = 0,
                regionsChanged = 0,
                regionsAlreadyRedacted = 0,
                pixelsChanged = false,
                inputChecksum = inputChecksum,
                outputChecksum = inputChecksum,
                checksumAlgorithm = NativePrivacyConstants.CHECKSUM_ALGORITHM,
                detectionDurationMs = detectionResult.durationMs,
                totalDurationMs = System.currentTimeMillis() - startedAt,
                warnings = listOf("No faces detected."),
            )
        }

        val normalizedBoxes = AndroidFaceBoxNormalizer.normalizeAndPad(
            faces = faces,
            imageWidth = inputWidth,
            imageHeight = inputHeight,
            paddingRatio = paddingRatio,
        )

        if (normalizedBoxes.isEmpty()) {
            source.recycle()
            return buildFailureResult(
                errorCode = NativePrivacyErrorCode.INVALID_REGION,
                reason = "Faces were detected but all regions were invalid after normalization.",
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                facesDetected = faces.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val maskingStartedAt = System.currentTimeMillis()
        val redactionResult = AndroidFaceRedactor.redactRegions(source, normalizedBoxes)
        if (redactionResult is RedactionResult.Failure) {
            source.recycle()
            return buildFailureResult(
                errorCode = redactionResult.errorCode,
                reason = redactionResult.reason,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                facesDetected = faces.size,
                facesAccepted = normalizedBoxes.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val redaction = redactionResult as RedactionResult.Success
        val maskingDurationMs = System.currentTimeMillis() - maskingStartedAt

        if (redaction.output.width != inputWidth || redaction.output.height != inputHeight) {
            redaction.output.recycle()
            source.recycle()
            return buildFailureResult(
                errorCode = NativePrivacyErrorCode.MASKING_FAILED,
                reason = "Redacted output dimensions do not match input dimensions.",
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                facesDetected = faces.size,
                facesAccepted = normalizedBoxes.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val encodingStartedAt = System.currentTimeMillis()
        val context = appContext.reactContext
        if (context == null) {
            redaction.output.recycle()
            source.recycle()
            return buildFailureResult(
                errorCode = NativePrivacyErrorCode.INTERNAL_ERROR,
                reason = "React context is not available.",
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                facesDetected = faces.size,
                facesAccepted = normalizedBoxes.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val outputFile = AndroidCacheManager.createOutputFile(context)
        val encodeSuccess = try {
            FileOutputStream(outputFile).use { out ->
                redaction.output.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            true
        } catch (e: Exception) {
            AndroidCacheManager.deleteUnverifiableOutput(outputFile)
            false
        }

        if (!encodeSuccess) {
            redaction.output.recycle()
            source.recycle()
            return buildFailureResult(
                errorCode = NativePrivacyErrorCode.ENCODING_FAILED,
                reason = "Failed to encode and write PNG output to ${outputFile.absolutePath}.",
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                facesDetected = faces.size,
                facesAccepted = normalizedBoxes.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val encodingDurationMs = System.currentTimeMillis() - encodingStartedAt

        val verification = AndroidOutputVerifier.verify(
            outputFile = outputFile,
            expectedWidth = inputWidth,
            expectedHeight = inputHeight,
            regions = normalizedBoxes,
        )

        if (verification is VerificationResult.Failure) {
            AndroidCacheManager.deleteUnverifiableOutput(outputFile)
            redaction.output.recycle()
            source.recycle()
            return buildFailureResult(
                errorCode = verification.errorCode,
                reason = verification.reason,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                facesDetected = faces.size,
                facesAccepted = normalizedBoxes.size,
                facesMasked = normalizedBoxes.size,
                pixelsChanged = redaction.pixelsChanged,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val verified = verification as VerificationResult.Success

        source.recycle()
        redaction.output.recycle()

        return NativeFaceMaskResult(
            status = NativePrivacyStatus.SUCCESS,
            platform = "android",
            detectorImplementation = "mlkit_bundled",
            detectorVersion = NativePrivacyConstants.DETECTOR_VERSION_MLKIT,
            sanitizerVersion = NativePrivacyConstants.SANITIZER_VERSION,
            inputWidth = inputWidth,
            inputHeight = inputHeight,
            outputWidth = verified.outputWidth,
            outputHeight = verified.outputHeight,
            facesDetected = faces.size,
            facesAccepted = normalizedBoxes.size,
            facesMasked = normalizedBoxes.size,
            regionsChanged = redaction.regionsChanged,
            regionsAlreadyRedacted = redaction.regionsAlreadyRedacted,
            pixelsChanged = redaction.pixelsChanged,
            sanitizedUri = "file://${outputFile.absolutePath}",
            inputChecksum = inputChecksum,
            outputChecksum = verified.outputChecksum,
            checksumAlgorithm = NativePrivacyConstants.CHECKSUM_ALGORITHM,
            detectionDurationMs = detectionResult.durationMs,
            maskingDurationMs = maskingDurationMs,
            encodingDurationMs = encodingDurationMs,
            verificationDurationMs = verified.durationMs,
            totalDurationMs = System.currentTimeMillis() - startedAt,
            warnings = emptyList(),
        )
    }

    private fun buildPlateCapabilities(): NativePlateCapabilities {
        return NativePlateCapabilities(
            supported = true,
            platform = "android",
            detectorImplementation = NativePrivacyConstants.PLATE_DETECTOR_IMPLEMENTATION,
            detectorVersion = NativePrivacyConstants.DETECTOR_VERSION_MLKIT_TEXT,
            sanitizerVersion = NativePrivacyConstants.PLATE_SANITIZER_VERSION,
            defaultPaddingRatio = NativePrivacyConstants.DEFAULT_PADDING_RATIO,
            minAspectRatio = NativePrivacyConstants.PLATE_MIN_ASPECT_RATIO,
            maxAspectRatio = NativePrivacyConstants.PLATE_MAX_ASPECT_RATIO,
            minWidthRatio = NativePrivacyConstants.PLATE_MIN_WIDTH_RATIO,
            minHeightPx = NativePrivacyConstants.PLATE_MIN_HEIGHT_PX,
            minAreaRatio = NativePrivacyConstants.PLATE_MIN_AREA_RATIO,
        )
    }

    /**
     * Plate masking, step for step identical to detectAndMaskFacesInternal.
     *
     * FAIL-CLOSED: there is no return in this function that reports SUCCESS
     * while referencing anything but a re-decoded, pixel-verified output file.
     * Detection, normalization, masking, encoding and verification each have a
     * typed FAILED exit, and an unverifiable output file is deleted before that
     * exit is taken. The NO_PLATES exit carries no sanitizedUri at all, so a
     * caller cannot mistake "nothing to mask" for "here is your masked image".
     */
    private suspend fun detectAndMaskPlatesInternal(
        input: NativePlateMaskInputRecord,
        startedAt: Long,
    ): NativePlateMaskResult {
        val imageUri = input.imageUri
        if (imageUri.isBlank()) {
            return buildPlateFailureResult(
                errorCode = NativePrivacyErrorCode.INVALID_INPUT,
                reason = "Missing or empty imageUri.",
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val paddingRatio = input.paddingRatio ?: NativePrivacyConstants.DEFAULT_PADDING_RATIO

        if (paddingRatio < NativePrivacyConstants.MIN_PADDING_RATIO ||
            paddingRatio > NativePrivacyConstants.MAX_PADDING_RATIO
        ) {
            return buildPlateFailureResult(
                errorCode = NativePrivacyErrorCode.INVALID_INPUT,
                reason = "paddingRatio must be between ${NativePrivacyConstants.MIN_PADDING_RATIO} and ${NativePrivacyConstants.MAX_PADDING_RATIO}.",
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val decodeResult = AndroidImageDecoder.decodeFileUri(imageUri)
        if (decodeResult is DecodeResult.Failure) {
            return buildPlateFailureResult(
                errorCode = decodeResult.errorCode,
                reason = decodeResult.reason,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        // From here on `source` is owned by this function and MUST be recycled
        // on every exit path, exactly as the face path does it.
        val source = (decodeResult as DecodeResult.Success).bitmap
        val inputWidth = source.width
        val inputHeight = source.height
        val inputChecksum = computeBitmapChecksum(source)

        val detectionResult = AndroidPlateDetector.detect(source)
        if (detectionResult is PlateDetectionResult.Failure) {
            source.recycle()
            return buildPlateFailureResult(
                errorCode = detectionResult.errorCode,
                reason = detectionResult.reason,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val detection = detectionResult as PlateDetectionResult.Success
        val plates = detection.plates
        if (plates.isEmpty()) {
            source.recycle()
            return NativePlateMaskResult(
                status = NativePlateStatus.NO_PLATES,
                platform = "android",
                detectorImplementation = NativePrivacyConstants.PLATE_DETECTOR_IMPLEMENTATION,
                detectorVersion = NativePrivacyConstants.DETECTOR_VERSION_MLKIT_TEXT,
                sanitizerVersion = NativePrivacyConstants.PLATE_SANITIZER_VERSION,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                platesDetected = 0,
                platesAccepted = 0,
                platesMasked = 0,
                regionsChanged = 0,
                regionsAlreadyRedacted = 0,
                pixelsChanged = false,
                inputChecksum = inputChecksum,
                outputChecksum = inputChecksum,
                checksumAlgorithm = NativePrivacyConstants.CHECKSUM_ALGORITHM,
                detectionDurationMs = detection.durationMs,
                totalDurationMs = System.currentTimeMillis() - startedAt,
                warnings = listOf("No plate-like regions detected."),
            )
        }

        // Same normalizer as faces, on purpose. It pads, applies the outward
        // rounding policy, clamps to the image and deduplicates by IoU — which
        // is what collapses the overlapping block/line boxes the plate detector
        // deliberately proposes.
        val normalizedBoxes = AndroidFaceBoxNormalizer.normalizeAndPad(
            faces = plates,
            imageWidth = inputWidth,
            imageHeight = inputHeight,
            paddingRatio = paddingRatio,
        )

        if (normalizedBoxes.isEmpty()) {
            source.recycle()
            return buildPlateFailureResult(
                errorCode = NativePrivacyErrorCode.INVALID_REGION,
                reason = "Plate regions were detected but all were invalid after normalization.",
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                platesDetected = plates.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val maskingStartedAt = System.currentTimeMillis()
        // AndroidFaceRedactor is region-generic: it fills the rectangles it is
        // handed with opaque black and proves the pixels moved. It has no idea
        // what was inside them, and does not need one.
        val redactionResult = AndroidFaceRedactor.redactRegions(source, normalizedBoxes)
        if (redactionResult is RedactionResult.Failure) {
            source.recycle()
            return buildPlateFailureResult(
                errorCode = redactionResult.errorCode,
                reason = redactionResult.reason,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                platesDetected = plates.size,
                platesAccepted = normalizedBoxes.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val redaction = redactionResult as RedactionResult.Success
        val maskingDurationMs = System.currentTimeMillis() - maskingStartedAt

        if (redaction.output.width != inputWidth || redaction.output.height != inputHeight) {
            redaction.output.recycle()
            source.recycle()
            return buildPlateFailureResult(
                errorCode = NativePrivacyErrorCode.MASKING_FAILED,
                reason = "Redacted output dimensions do not match input dimensions.",
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                platesDetected = plates.size,
                platesAccepted = normalizedBoxes.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val encodingStartedAt = System.currentTimeMillis()
        val context = appContext.reactContext
        if (context == null) {
            redaction.output.recycle()
            source.recycle()
            return buildPlateFailureResult(
                errorCode = NativePrivacyErrorCode.INTERNAL_ERROR,
                reason = "React context is not available.",
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                platesDetected = plates.size,
                platesAccepted = normalizedBoxes.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val outputFile = AndroidCacheManager.createOutputFile(context)
        val encodeSuccess = try {
            FileOutputStream(outputFile).use { out ->
                redaction.output.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            true
        } catch (e: Exception) {
            // A half-written file must never survive to be read as sanitized.
            AndroidCacheManager.deleteUnverifiableOutput(outputFile)
            false
        }

        if (!encodeSuccess) {
            redaction.output.recycle()
            source.recycle()
            return buildPlateFailureResult(
                errorCode = NativePrivacyErrorCode.ENCODING_FAILED,
                reason = "Failed to encode and write PNG output to ${outputFile.absolutePath}.",
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                platesDetected = plates.size,
                platesAccepted = normalizedBoxes.size,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val encodingDurationMs = System.currentTimeMillis() - encodingStartedAt

        // Verification re-decodes what was actually persisted and proves every
        // accepted region is opaque black ON DISK. Masking a bitmap in memory
        // is not the claim being made; the file is.
        val verification = AndroidOutputVerifier.verify(
            outputFile = outputFile,
            expectedWidth = inputWidth,
            expectedHeight = inputHeight,
            regions = normalizedBoxes,
        )

        if (verification is VerificationResult.Failure) {
            AndroidCacheManager.deleteUnverifiableOutput(outputFile)
            redaction.output.recycle()
            source.recycle()
            return buildPlateFailureResult(
                errorCode = verification.errorCode,
                reason = verification.reason,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                inputChecksum = inputChecksum,
                platesDetected = plates.size,
                platesAccepted = normalizedBoxes.size,
                platesMasked = normalizedBoxes.size,
                pixelsChanged = redaction.pixelsChanged,
                totalDurationMs = System.currentTimeMillis() - startedAt,
            )
        }

        val verified = verification as VerificationResult.Success

        source.recycle()
        redaction.output.recycle()

        return NativePlateMaskResult(
            status = NativePlateStatus.SUCCESS,
            platform = "android",
            detectorImplementation = NativePrivacyConstants.PLATE_DETECTOR_IMPLEMENTATION,
            detectorVersion = NativePrivacyConstants.DETECTOR_VERSION_MLKIT_TEXT,
            sanitizerVersion = NativePrivacyConstants.PLATE_SANITIZER_VERSION,
            inputWidth = inputWidth,
            inputHeight = inputHeight,
            outputWidth = verified.outputWidth,
            outputHeight = verified.outputHeight,
            platesDetected = plates.size,
            platesAccepted = normalizedBoxes.size,
            platesMasked = normalizedBoxes.size,
            regionsChanged = redaction.regionsChanged,
            regionsAlreadyRedacted = redaction.regionsAlreadyRedacted,
            pixelsChanged = redaction.pixelsChanged,
            sanitizedUri = "file://${outputFile.absolutePath}",
            inputChecksum = inputChecksum,
            outputChecksum = verified.outputChecksum,
            checksumAlgorithm = NativePrivacyConstants.CHECKSUM_ALGORITHM,
            detectionDurationMs = detection.durationMs,
            maskingDurationMs = maskingDurationMs,
            encodingDurationMs = encodingDurationMs,
            verificationDurationMs = verified.durationMs,
            totalDurationMs = System.currentTimeMillis() - startedAt,
            warnings = emptyList(),
        )
    }

    private suspend fun detectPersonRegionsInternal(
        input: NativePersonDetectionInputRecord,
        startedAt: Long,
    ): NativePersonDetectionResult {
        val imageUri = input.imageUri
        if (imageUri.isBlank()) {
            return NativePersonDetectionResult(
                status = NativeExtractionStatus.FAILED,
                errorCode = NativePrivacyErrorCode.INVALID_INPUT,
                failureReason = "Missing or empty imageUri.",
                totalDurationMs = System.currentTimeMillis() - startedAt,
                warnings = listOf("Missing image."),
            )
        }

        val decodeResult = AndroidImageDecoder.decodeFileUri(imageUri)
        if (decodeResult is DecodeResult.Failure) {
            return NativePersonDetectionResult(
                status = NativeExtractionStatus.FAILED,
                errorCode = decodeResult.errorCode,
                failureReason = decodeResult.reason,
                totalDurationMs = System.currentTimeMillis() - startedAt,
                warnings = listOf("Could not decode the source image."),
            )
        }

        val source = (decodeResult as DecodeResult.Success).bitmap
        val inputWidth = source.width
        val inputHeight = source.height

        val detection = try {
            AndroidPersonDetector.detect(source)
        } finally {
            // The bitmap is ours; nothing downstream holds a reference to it.
            source.recycle()
        }

        if (detection is AndroidPersonDetector.Result.Failure) {
            return NativePersonDetectionResult(
                status = NativeExtractionStatus.FAILED,
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                errorCode = detection.errorCode,
                failureReason = detection.reason,
                totalDurationMs = System.currentTimeMillis() - startedAt,
                warnings = listOf("Person detection failed."),
            )
        }

        val success = detection as AndroidPersonDetector.Result.Success
        return NativePersonDetectionResult(
            // `no_person` is a distinct status from `failed` on purpose: one is
            // a fact about the photograph the user can act on, the other is a
            // fault they cannot.
            status = if (success.persons.isEmpty()) NativeExtractionStatus.NO_PERSON
            else NativeExtractionStatus.SUCCESS,
            persons = success.persons,
            inputWidth = inputWidth,
            inputHeight = inputHeight,
            detectionDurationMs = success.durationMs,
            totalDurationMs = System.currentTimeMillis() - startedAt,
            warnings = if (success.persons.isEmpty()) listOf("No person detected.") else emptyList(),
        )
    }

    private fun computeBitmapChecksum(bitmap: Bitmap): String {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        val bytes = ByteArray(pixels.size * 4)
        for (i in pixels.indices) {
            val pixel = pixels[i]
            bytes[i * 4] = android.graphics.Color.red(pixel).toByte()
            bytes[i * 4 + 1] = android.graphics.Color.green(pixel).toByte()
            bytes[i * 4 + 2] = android.graphics.Color.blue(pixel).toByte()
            bytes[i * 4 + 3] = android.graphics.Color.alpha(pixel).toByte()
        }
        return AndroidOutputVerifier.checksumBuffer(bytes)
    }

    private fun buildFailureResult(
        errorCode: NativePrivacyErrorCode,
        reason: String,
        inputWidth: Int? = null,
        inputHeight: Int? = null,
        inputChecksum: String? = null,
        facesDetected: Int = 0,
        facesAccepted: Int = 0,
        facesMasked: Int = 0,
        pixelsChanged: Boolean = false,
        totalDurationMs: Long? = null,
    ): NativeFaceMaskResult {
        return NativeFaceMaskResult(
            status = NativePrivacyStatus.FAILED,
            platform = "android",
            detectorImplementation = "mlkit_bundled",
            detectorVersion = NativePrivacyConstants.DETECTOR_VERSION_MLKIT,
            sanitizerVersion = NativePrivacyConstants.SANITIZER_VERSION,
            inputWidth = inputWidth,
            inputHeight = inputHeight,
            inputChecksum = inputChecksum,
            facesDetected = facesDetected,
            facesAccepted = facesAccepted,
            facesMasked = facesMasked,
            regionsChanged = 0,
            regionsAlreadyRedacted = 0,
            pixelsChanged = pixelsChanged,
            errorCode = errorCode,
            failureReason = reason,
            totalDurationMs = totalDurationMs,
            warnings = listOf(reason),
        )
    }

    /**
     * The ONLY way this module reports a plate failure.
     *
     * Status is hard-coded FAILED and `sanitizedUri` is not a parameter, so no
     * caller of this builder — present or future — can construct a failure that
     * points at an image file. Whatever went wrong, the original stays where it
     * was and is never described as sanitized.
     */
    private fun buildPlateFailureResult(
        errorCode: NativePrivacyErrorCode,
        reason: String,
        inputWidth: Int? = null,
        inputHeight: Int? = null,
        inputChecksum: String? = null,
        platesDetected: Int = 0,
        platesAccepted: Int = 0,
        platesMasked: Int = 0,
        pixelsChanged: Boolean = false,
        totalDurationMs: Long? = null,
    ): NativePlateMaskResult {
        return NativePlateMaskResult(
            status = NativePlateStatus.FAILED,
            platform = "android",
            detectorImplementation = NativePrivacyConstants.PLATE_DETECTOR_IMPLEMENTATION,
            detectorVersion = NativePrivacyConstants.DETECTOR_VERSION_MLKIT_TEXT,
            sanitizerVersion = NativePrivacyConstants.PLATE_SANITIZER_VERSION,
            inputWidth = inputWidth,
            inputHeight = inputHeight,
            inputChecksum = inputChecksum,
            platesDetected = platesDetected,
            platesAccepted = platesAccepted,
            platesMasked = platesMasked,
            regionsChanged = 0,
            regionsAlreadyRedacted = 0,
            pixelsChanged = pixelsChanged,
            errorCode = errorCode,
            failureReason = reason,
            totalDurationMs = totalDurationMs,
            warnings = listOf(reason),
        )
    }
}
