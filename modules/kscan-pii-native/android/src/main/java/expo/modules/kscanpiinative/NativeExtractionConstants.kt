package expo.modules.kscanpiinative

/**
 * Person / body-region extraction constants (Build 2.5 Step 3).
 *
 * Kept beside NativePrivacyConstants rather than merged into it: face masking
 * and body-region extraction are two capabilities that happen to share a
 * module, and folding their vocabularies together would make a change to one
 * look like a change to both.
 */
object NativeExtractionConstants {
    const val EXTRACTOR_VERSION = "native-person-regions-1.0.0"

    /**
     * ML Kit pose detection, BUNDLED. The artifact carries the model inside the
     * APK, so the first run works with no network and no Play-Services model
     * download — which is the whole reason the Play-delivered subject-
     * segmentation option was rejected.
     */
    const val DETECTOR_VERSION_MLKIT_POSE = "18.0.0-beta5"
    const val DETECTOR_IMPLEMENTATION = "mlkit_pose"

    /**
     * ML Kit pose detection reports exactly ONE subject per image, so the
     * multi-person signal comes from the face detector this module already
     * bundles. See AndroidPersonDetector for how the two are combined and why
     * ranking uses face boxes on both sides of the comparison.
     */
    const val SEGMENTATION_MASK_SUPPORTED = false

    /** Minimum in-frame likelihood for a pose landmark to be reported at all. */
    const val MIN_LANDMARK_LIKELIHOOD = 0.1f

    /**
     * Head-height multiple used to grow a face box into an approximate body box
     * for a person who has no pose. Roughly the classical figure-drawing ratio.
     *
     * This is ONLY ever used for a NON-primary candidate, whose bounds are
     * never cropped from — a person without landmarks yields no region. If such
     * a person is later chosen by the user, the pipeline reports that no
     * garment region could be isolated rather than cropping an estimate.
     */
    const val FACE_TO_BODY_HEIGHT_RATIO = 7.5f
    const val FACE_TO_BODY_WIDTH_RATIO = 3.0f

    /**
     * Face boxes smaller than this fraction of the frame's shorter edge are
     * treated as background and do not create a candidate. Without this, a
     * reflection or a face on a poster becomes a person and every mirror selfie
     * taken in a shop is "ambiguous".
     */
    const val MIN_FACE_EDGE_RATIO = 0.04f
}

/** The joint subset both platforms report. Must match SUPPORTED_BODY_LANDMARKS. */
enum class BodyLandmarkType(val wireName: String) {
    NOSE("nose"),
    LEFT_SHOULDER("left_shoulder"),
    RIGHT_SHOULDER("right_shoulder"),
    LEFT_HIP("left_hip"),
    RIGHT_HIP("right_hip"),
    LEFT_KNEE("left_knee"),
    RIGHT_KNEE("right_knee"),
    LEFT_ANKLE("left_ankle"),
    RIGHT_ANKLE("right_ankle"),
}
