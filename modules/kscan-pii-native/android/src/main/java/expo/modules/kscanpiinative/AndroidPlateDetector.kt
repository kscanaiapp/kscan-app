package expo.modules.kscanpiinative

import android.graphics.Bitmap
import android.graphics.Rect
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

sealed class PlateDetectionResult {
    data class Success(
        /**
         * Plate-like regions in SOURCE PIXELS, already clamped to the image.
         *
         * Typed as FaceRect on purpose. FaceRect carries four floats and no face
         * semantics whatsoever, and reusing it is what lets plate regions run
         * through the SAME audited normalizer, redactor and verifier as faces
         * with no parallel implementation to keep in sync. AndroidPersonDetector
         * already reuses it the same way.
         */
        val plates: List<FaceRect>,
        /**
         * Count of candidate boxes seen before geometry filtering — a COUNT of
         * rectangles, never their contents.
         *
         * Deliberately NOT put on the bridge: the shared TypeScript contract
         * does not declare it, and an undeclared extra field on a privacy
         * result is exactly the thing an audit has to chase down. It is kept
         * here because measuring this heuristic's rejection rate on a physical
         * build needs it, and adding it to the contract later is cheap.
         */
        val regionsConsidered: Int,
        val durationMs: Long,
    ) : PlateDetectionResult()

    data class Failure(
        val errorCode: NativePrivacyErrorCode,
        val reason: String,
    ) : PlateDetectionResult()
}

/**
 * On-device license-plate REGION screening.
 *
 * ── WHY A TEXT RECOGNIZER, AND WHY IT NEVER READS TEXT ──────────────────────
 *
 * There is no bundled, offline, first-party plate detector on Android. What
 * there is, is a bundled text recognizer — and a plate is a rectangle of text
 * with an unusually consistent shape. So this class runs the recognizer purely
 * as a REGION PROPOSER and throws away everything it actually recognized.
 *
 * THE RECOGNIZED CHARACTERS ARE NEVER READ. `Text.getText()`, `TextBlock.text`,
 * `Line.text` and `Element.text` are never called, anywhere, on any path. No
 * recognized string is returned across the bridge, written to a log, put in an
 * error message, or persisted. This is a PRIVACY REQUIREMENT, not a preference
 * or an optimization: reading the characters would turn a masking pipeline into
 * an OCR pipeline over the user's private photographs, and every downstream
 * promise this module makes ("nothing leaves the device", "nothing is stored")
 * would then be a promise about data we had chosen to extract anyway.
 *
 * The honest limit of that claim: the recognizer holds the characters in its own
 * result object for as long as the JVM takes to collect it. We never read them,
 * never copy them and keep no reference past this function — but this class
 * cannot zero another library's heap, and saying otherwise would be false.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * Not an ALPR. It does not know a plate from a bumper sticker of the same shape,
 * does not validate plate formats, does not identify a vehicle, and produces no
 * confidence score of its own — ML Kit's per-region confidence is about
 * character legibility, which is precisely the signal this class refuses to use.
 * It answers one question: "is this text region shaped like a plate?" A shaped-
 * like-a-plate sign gets masked too. Over-masking is the deliberate direction of
 * error, because the failure it prevents is unrecoverable and the failure it
 * causes is a black bar in a closet photo.
 *
 * NEVER FABRICATES. Any recognizer error is a Failure. There is no path where a
 * fault is reported as "no plates found".
 */
object AndroidPlateDetector {

    private val recognizer by lazy {
        // DEFAULT_OPTIONS is the bundled Latin recognizer. No options are set:
        // every knob this API exposes is about text quality, and this class
        // consumes geometry only.
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    suspend fun detect(bitmap: Bitmap): PlateDetectionResult {
        val width = bitmap.width
        val height = bitmap.height
        if (width <= 0 || height <= 0) {
            return PlateDetectionResult.Failure(
                NativePrivacyErrorCode.INVALID_INPUT,
                "Source bitmap has no usable dimensions.",
            )
        }

        val inputImage = try {
            // Rotation 0: the caller supplies a bitmap whose EXIF orientation is
            // already baked into the pixels by AndroidImageDecoder. Passing a
            // rotation here would apply it a second time. Same contract as
            // AndroidFaceDetector and AndroidPersonDetector.
            InputImage.fromBitmap(bitmap, 0)
        } catch (e: Exception) {
            return PlateDetectionResult.Failure(
                NativePrivacyErrorCode.DETECTION_FAILED,
                "Failed to create ML Kit input image: ${e.message}",
            )
        }

        // Client construction is resolved BEFORE the timing window and reported
        // with its own code. A missing or unloadable recognizer is a different
        // fault from an inference that ran and failed, and the error vocabulary
        // already distinguishes them.
        val client = try {
            recognizer
        } catch (e: Exception) {
            return PlateDetectionResult.Failure(
                NativePrivacyErrorCode.DETECTOR_UNAVAILABLE,
                "ML Kit text recognizer is unavailable: ${e.message}",
            )
        }

        val startedAt = System.currentTimeMillis()
        return try {
            // ML Kit is Task-based and the pipeline around it is coroutine-based.
            // Bridged exactly as AndroidFaceDetector bridges face detection:
            // suspendCoroutine, resume on success, resumeWithException on
            // failure. NO TIMEOUT — the face detector has none either, and
            // giving only this one detector a deadline would mean the same hung
            // device produced a typed failure for plates and an unresolved
            // promise for faces. That symmetry is intentional; the shared risk
            // of a hanging Task is real and is recorded, not papered over here.
            val recognized = suspendCoroutine<Text> { continuation ->
                client.process(inputImage)
                    .addOnSuccessListener { continuation.resume(it) }
                    .addOnFailureListener { continuation.resumeWithException(it) }
            }

            // Only bounding boxes are touched. `recognized.text` and every
            // per-region `.text` are deliberately not read. See the class note.
            val candidates = mutableListOf<Rect>()
            for (block in recognized.textBlocks) {
                block.boundingBox?.let { candidates.add(it) }
                // Lines as well as blocks, because a block can merge a plate
                // with whatever is stencilled above or below it on the vehicle —
                // a merged box has the wrong shape, while the plate's own line
                // still has the right one. Near-duplicate block/line pairs are
                // collapsed downstream by the normalizer's IoU deduplication,
                // which is the same pass that deduplicates overlapping faces.
                for (line in block.lines) {
                    line.boundingBox?.let { candidates.add(it) }
                }
            }

            val plates = candidates.mapNotNull { plateLikeRegion(it, width, height) }

            PlateDetectionResult.Success(
                plates = plates,
                regionsConsidered = candidates.size,
                durationMs = System.currentTimeMillis() - startedAt,
            )
        } catch (e: Exception) {
            PlateDetectionResult.Failure(
                NativePrivacyErrorCode.DETECTION_FAILED,
                "ML Kit text recognition failed: ${e.message}",
            )
        }
    }

    /**
     * The whole plate heuristic: shape, size, and nothing else.
     *
     * Clamps FIRST and measures SECOND. A region that runs off the frame edge
     * must be judged on the part that is actually in the image — measuring the
     * reported box and clamping afterwards would accept a shape that does not
     * exist in the picture, and would hand the redactor a rectangle outside the
     * bitmap.
     *
     * Returns null for anything that is not plate-like. Every threshold lives in
     * NativePrivacyConstants with its reasoning.
     */
    private fun plateLikeRegion(box: Rect, imageWidth: Int, imageHeight: Int): FaceRect? {
        val left = box.left.coerceIn(0, imageWidth)
        val top = box.top.coerceIn(0, imageHeight)
        val right = box.right.coerceIn(0, imageWidth)
        val bottom = box.bottom.coerceIn(0, imageHeight)

        val regionWidth = (right - left).toDouble()
        val regionHeight = (bottom - top).toDouble()
        if (regionWidth <= 0.0 || regionHeight <= 0.0) {
            return null
        }

        // Absolute legibility floor before any ratio is computed: on a small
        // image a relative test alone would accept a few pixels of noise.
        if (regionHeight < NativePrivacyConstants.PLATE_MIN_HEIGHT_PX) {
            return null
        }

        val aspectRatio = regionWidth / regionHeight
        if (aspectRatio < NativePrivacyConstants.PLATE_MIN_ASPECT_RATIO ||
            aspectRatio > NativePrivacyConstants.PLATE_MAX_ASPECT_RATIO
        ) {
            return null
        }

        if (regionWidth / imageWidth.toDouble() < NativePrivacyConstants.PLATE_MIN_WIDTH_RATIO) {
            return null
        }

        val areaRatio = (regionWidth * regionHeight) /
            (imageWidth.toDouble() * imageHeight.toDouble())
        if (areaRatio < NativePrivacyConstants.PLATE_MIN_AREA_RATIO) {
            return null
        }

        return FaceRect(
            left = left.toFloat(),
            top = top.toFloat(),
            right = right.toFloat(),
            bottom = bottom.toFloat(),
        )
    }
}
