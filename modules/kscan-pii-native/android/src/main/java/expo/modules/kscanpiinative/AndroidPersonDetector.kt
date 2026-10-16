package expo.modules.kscanpiinative

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.pose.Pose
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.PoseLandmark
import com.google.mlkit.vision.pose.defaults.PoseDetectorOptions
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlin.math.max
import kotlin.math.min

/**
 * Person and body-landmark detection for Mirror Selfie extraction.
 *
 * ── THE ONE-SUBJECT PROBLEM, AND HOW IT IS SOLVED HONESTLY ──────────────────
 *
 * ML Kit pose detection returns the pose of exactly ONE person — the most
 * prominent subject — and offers no way to enumerate the others. That is fine
 * for landmarks (we only ever derive garments from one person anyway) and
 * useless for the safety question, which is "is there more than one person in
 * this photo, and am I sure which one is the user?"
 *
 * So the count comes from the FACE DETECTOR this module already bundles. It is
 * a proxy — a person facing away has no face — but it is a real detection of a
 * real person, it costs no new dependency, and it fails in the safe direction:
 * an undetected face means one fewer reason to interrupt the user, while a
 * detected bystander correctly triggers the ambiguity check.
 *
 * ── WHY RANKING USES FACE BOXES ON BOTH SIDES ───────────────────────────────
 *
 * The posed subject gets a full-body box from their landmarks; everyone else
 * gets a box estimated from their face. Comparing those two KINDS of box would
 * make the posed subject win every single time, including when a second person
 * is standing directly beside them — the exact case that must stop and ask. So
 * `rankingExtent` is the FACE box for every candidate, and `bounds` is the best
 * body extent available for that candidate. The caller ranks on the former and
 * crops from the latter.
 *
 * ── WHAT IS NEVER DONE HERE ─────────────────────────────────────────────────
 *
 * No garment is identified. No two people are merged. The input bitmap is read
 * and never modified, and no derivative file is written — unlike face masking,
 * this capability produces geometry only.
 */
object AndroidPersonDetector {

    private val poseDetector by lazy {
        val options = PoseDetectorOptions.Builder()
            // SINGLE_IMAGE_MODE, not STREAM_MODE: there is no video here, and
            // stream mode's inter-frame tracking would be pure overhead.
            .setDetectorMode(PoseDetectorOptions.SINGLE_IMAGE_MODE)
            .build()
        PoseDetection.getClient(options)
    }

    sealed class Result {
        data class Success(
            val persons: List<DetectedPerson>,
            val durationMs: Long,
        ) : Result()

        data class Failure(
            val errorCode: NativePrivacyErrorCode,
            val reason: String,
        ) : Result()
    }

    suspend fun detect(bitmap: Bitmap): Result {
        val width = bitmap.width
        val height = bitmap.height
        if (width <= 0 || height <= 0) {
            return Result.Failure(
                NativePrivacyErrorCode.INVALID_INPUT,
                "Source bitmap has no usable dimensions.",
            )
        }

        val inputImage = try {
            // Rotation 0: the caller supplies an image whose EXIF orientation is
            // already baked into the pixels. Passing a rotation here would
            // apply it a second time.
            InputImage.fromBitmap(bitmap, 0)
        } catch (e: Exception) {
            return Result.Failure(
                NativePrivacyErrorCode.DETECTION_FAILED,
                "Failed to create ML Kit input image: ${e.message}",
            )
        }

        val startedAt = System.currentTimeMillis()

        // (1) Faces first — this is the multi-person signal and the ranking
        // basis. Reuses the already-bundled detector via its existing wrapper.
        val faceResult = AndroidFaceDetector.detect(bitmap)
        if (faceResult is DetectionResult.Failure) {
            return Result.Failure(faceResult.errorCode, faceResult.reason)
        }
        val faces = (faceResult as DetectionResult.Success).faces
            .filter { usableFace(it, width, height) }

        // (2) Pose for the prominent subject.
        val pose = try {
            suspendCoroutine<Pose> { continuation ->
                poseDetector.process(inputImage)
                    .addOnSuccessListener { continuation.resume(it) }
                    .addOnFailureListener { continuation.resumeWithException(it) }
            }
        } catch (e: Exception) {
            return Result.Failure(
                NativePrivacyErrorCode.DETECTION_FAILED,
                "ML Kit pose detection failed: ${e.message}",
            )
        }

        val landmarks = extractLandmarks(pose, width, height)
        val poseBounds = boundsFromLandmarks(pose, width, height)
        val durationMs = System.currentTimeMillis() - startedAt

        // (3) Attach the pose to the face it belongs to.
        //
        // Matched on the nose landmark falling inside a face box, which is a
        // containment test rather than a guess. When the nose is missing or
        // matches nothing — subject turned away, or face undetected — the pose
        // becomes its own candidate ranked by a face-sized proxy so it stays
        // comparable with the others.
        val nose = pose.getPoseLandmark(PoseLandmark.NOSE)
        var poseFaceIndex = -1
        if (nose != null && nose.inFrameLikelihood >= NativeExtractionConstants.MIN_LANDMARK_LIKELIHOOD) {
            poseFaceIndex = faces.indexOfFirst { face ->
                nose.position.x >= face.left && nose.position.x <= face.right &&
                    nose.position.y >= face.top && nose.position.y <= face.bottom
            }
        }

        val persons = mutableListOf<DetectedPerson>()

        faces.forEachIndexed { index, face ->
            val faceRect = NormalizedRect.fromPixels(
                face.left, face.top, face.right, face.bottom, width, height,
            ) ?: return@forEachIndexed

            val isPosed = index == poseFaceIndex && landmarks.isNotEmpty()
            val bodyRect = if (isPosed && poseBounds != null) {
                poseBounds
            } else {
                estimateBodyFromFace(face, width, height) ?: faceRect
            }

            persons.add(
                DetectedPerson(
                    bounds = bodyRect,
                    rankingExtent = faceRect,
                    // A face detection that survived the size filter is a person.
                    // ML Kit's face detector exposes no per-face score, so a
                    // fixed value is reported rather than a fabricated one; the
                    // caller's confidence threshold is satisfied and its
                    // RANKING is done on area, which is a real measurement.
                    confidence = 1.0f,
                    landmarks = if (isPosed) landmarks else emptyList(),
                ),
            )
        }

        // A posed subject whose face was not detected still has to be offered —
        // people photograph themselves from behind, and in a mirror at an angle.
        if (poseFaceIndex < 0 && landmarks.isNotEmpty() && poseBounds != null) {
            persons.add(
                DetectedPerson(
                    bounds = poseBounds,
                    // Proxy ranking extent: the head-sized top slice of the body
                    // box, so this candidate is compared on the same scale as
                    // any face-derived candidate rather than winning on a
                    // whole-body area.
                    rankingExtent = headProxy(poseBounds),
                    confidence = 1.0f,
                    landmarks = landmarks,
                ),
            )
        }

        return Result.Success(persons = persons, durationMs = durationMs)
    }

    private fun usableFace(face: FaceRect, width: Int, height: Int): Boolean {
        val shortEdge = min(width, height).toFloat()
        if (shortEdge <= 0f) return false
        val faceEdge = max(face.right - face.left, face.bottom - face.top)
        return faceEdge / shortEdge >= NativeExtractionConstants.MIN_FACE_EDGE_RATIO
    }

    /** Landmarks we report, filtered by ML Kit's own in-frame likelihood. */
    private fun extractLandmarks(pose: Pose, width: Int, height: Int): List<BodyLandmark> {
        val mapping = listOf(
            BodyLandmarkType.NOSE to PoseLandmark.NOSE,
            BodyLandmarkType.LEFT_SHOULDER to PoseLandmark.LEFT_SHOULDER,
            BodyLandmarkType.RIGHT_SHOULDER to PoseLandmark.RIGHT_SHOULDER,
            BodyLandmarkType.LEFT_HIP to PoseLandmark.LEFT_HIP,
            BodyLandmarkType.RIGHT_HIP to PoseLandmark.RIGHT_HIP,
            BodyLandmarkType.LEFT_KNEE to PoseLandmark.LEFT_KNEE,
            BodyLandmarkType.RIGHT_KNEE to PoseLandmark.RIGHT_KNEE,
            BodyLandmarkType.LEFT_ANKLE to PoseLandmark.LEFT_ANKLE,
            BodyLandmarkType.RIGHT_ANKLE to PoseLandmark.RIGHT_ANKLE,
        )
        val out = mutableListOf<BodyLandmark>()
        for ((type, mlkitType) in mapping) {
            val landmark = pose.getPoseLandmark(mlkitType) ?: continue
            if (landmark.inFrameLikelihood < NativeExtractionConstants.MIN_LANDMARK_LIKELIHOOD) continue
            out.add(
                BodyLandmark(
                    type = type,
                    x = (landmark.position.x / width).coerceIn(0f, 1f),
                    y = (landmark.position.y / height).coerceIn(0f, 1f),
                    confidence = landmark.inFrameLikelihood.coerceIn(0f, 1f),
                ),
            )
        }
        return out
    }

    /** Tight box around every reported landmark. Null when there are none. */
    private fun boundsFromLandmarks(pose: Pose, width: Int, height: Int): NormalizedRect? {
        val points = pose.allPoseLandmarks
            .filter { it.inFrameLikelihood >= NativeExtractionConstants.MIN_LANDMARK_LIKELIHOOD }
        if (points.isEmpty()) return null
        var left = Float.MAX_VALUE
        var top = Float.MAX_VALUE
        var right = -Float.MAX_VALUE
        var bottom = -Float.MAX_VALUE
        for (point in points) {
            left = min(left, point.position.x)
            top = min(top, point.position.y)
            right = max(right, point.position.x)
            bottom = max(bottom, point.position.y)
        }
        // Landmarks sit on the skeleton, inside the silhouette. A margin keeps
        // the sleeve, the hem and the shoe inside the body box rather than on
        // its edge.
        val padX = (right - left) * 0.18f
        val padY = (bottom - top) * 0.08f
        return NormalizedRect.fromPixels(
            left - padX, top - padY, right + padX, bottom + padY, width, height,
        )
    }

    /**
     * Approximate body box for a person with a face but no pose.
     *
     * Used for RANKING CONTEXT ONLY — a candidate without landmarks yields no
     * garment region, so this box is never cropped from. See the note on
     * FACE_TO_BODY_HEIGHT_RATIO.
     */
    private fun estimateBodyFromFace(face: FaceRect, width: Int, height: Int): NormalizedRect? {
        val faceHeight = face.bottom - face.top
        val faceWidth = face.right - face.left
        if (faceHeight <= 0f || faceWidth <= 0f) return null
        val centerX = (face.left + face.right) / 2f
        val bodyWidth = faceWidth * NativeExtractionConstants.FACE_TO_BODY_WIDTH_RATIO
        val bodyHeight = faceHeight * NativeExtractionConstants.FACE_TO_BODY_HEIGHT_RATIO
        return NormalizedRect.fromPixels(
            centerX - bodyWidth / 2f,
            face.top,
            centerX + bodyWidth / 2f,
            face.top + bodyHeight,
            width,
            height,
        )
    }

    /** Head-sized top slice of a body box, for like-for-like ranking. */
    private fun headProxy(body: NormalizedRect): NormalizedRect {
        val headHeight = body.height / NativeExtractionConstants.FACE_TO_BODY_HEIGHT_RATIO
        val headWidth = body.width / NativeExtractionConstants.FACE_TO_BODY_WIDTH_RATIO
        val centerX = body.x + body.width / 2f
        return NormalizedRect(
            x = (centerX - headWidth / 2f).coerceIn(0f, 1f),
            y = body.y,
            width = headWidth.coerceAtMost(1f),
            height = headHeight.coerceAtMost(1f),
        )
    }
}
