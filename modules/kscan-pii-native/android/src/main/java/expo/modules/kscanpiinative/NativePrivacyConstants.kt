package expo.modules.kscanpiinative

object NativePrivacyConstants {
    const val MODULE_NAME = "KScanPiiNative"

    const val SANITIZER_VERSION = "native-face-mask-poc-1.0.0"
    const val DETECTOR_VERSION_MLKIT = "16.1.7"
    const val DETECTOR_VERSION_APPLE_VISION = "1"

    const val ACCEPTED_URI_SCHEME = "file"
    val ACCEPTED_MIME_TYPES = setOf("image/jpeg", "image/png")
    const val OUTPUT_MIME_TYPE = "image/png"
    const val OUTPUT_EXTENSION = "png"

    const val MAX_WIDTH = 4096
    const val MAX_HEIGHT = 4096
    const val MAX_PIXELS = 16_777_216L

    const val DEFAULT_PADDING_RATIO = 0.15
    const val MIN_PADDING_RATIO = 0.0
    const val MAX_PADDING_RATIO = 0.5

    const val IOU_DEDUPLICATION_THRESHOLD = 0.5

    // Opaque black.
    const val REDACTION_COLOR_R = 0
    const val REDACTION_COLOR_G = 0
    const val REDACTION_COLOR_B = 0
    const val REDACTION_COLOR_A = 255

    const val CHECKSUM_ALGORITHM = "fnv1a-dual-lane-64"

    const val CACHE_NAMESPACE = "kscan-pii-native"
    const val OUTPUT_FILE_PREFIX = "kscan-pii-"

    // Match TypeScript outward rounding policy from the audited POC.
    // Start edges are floored; end edges are ceiled.

    // ── License-plate region screening (Build 34, closet media privacy) ──────
    //
    // These live beside the face constants rather than in a second object
    // because plate masking is not a second capability. It is the same privacy
    // pipeline — same decoder, same normalizer, same redactor, same verifier,
    // same irreversible opaque rectangle — asked a different question about
    // WHICH regions to destroy. Only the selection differs, and the selection
    // is entirely described by the thresholds below. Nothing here is tuned
    // against a measured corpus; every value is a stated judgement that must be
    // checked on a physical build.

    const val PLATE_SANITIZER_VERSION = "native-plate-mask-1.0.0"

    /**
     * Bundled ML Kit Latin text recognition. The artifact carries the model in
     * the APK, so screening runs with no network and no first-run download —
     * the same reason the Play-delivered variant was rejected for the face and
     * pose detectors. See android/build.gradle for the full rationale.
     */
    const val DETECTOR_VERSION_MLKIT_TEXT = "16.0.1"
    const val PLATE_DETECTOR_IMPLEMENTATION = "mlkit_text_bundled"

    /**
     * ── THE PLATE GEOMETRY BAND ─────────────────────────────────────────────
     *
     * The detector receives TEXT REGIONS and must decide which of them are
     * plate-like WITHOUT reading a single character (see AndroidPlateDetector
     * for why that constraint is absolute). Shape is therefore the only
     * evidence available, and these five thresholds are the whole decision.
     *
     * Narrowest plate this band is expected to meet: a US/Canada passenger
     * plate is 12x6 inches — exactly 2:1 — so 2.0 is the floor and the
     * comparison is inclusive. Anything squarer than that is a word, a label,
     * a caption, a garment tag, a line of a book.
     *
     * KNOWN GAP, stated rather than hidden: motorcycle plates and the square
     * formats used in parts of Asia sit nearer 1.4:1 and are NOT selected by
     * this band. Lowering the floor to catch them would pull in most ordinary
     * short text in the frame, and a pipeline that blacks out every word on a
     * garment is one users switch off.
     */
    const val PLATE_MIN_ASPECT_RATIO = 2.0

    /**
     * A single-row EU plate (520x110mm) is roughly 4.7:1. ML Kit's box hugs the
     * CHARACTERS, which are inset from the plate's edges, so the measured ratio
     * of a real plate's text can run wider than the plate itself. 6.5 leaves
     * that headroom while still rejecting the long thin regions that dominate
     * street photography — banners, shop fascias, road signs, and any line of
     * running body text, all of which are far longer than this.
     */
    const val PLATE_MAX_ASPECT_RATIO = 6.5

    /**
     * Minimum region width as a fraction of image width.
     *
     * A plate-shaped region narrower than 3% of the frame is either far away or
     * incidental. Masking it stamps a visible black bar into the user's own
     * photo to hide a plate nobody could read from that photo. The trade is
     * deliberately biased toward fewer false positives; its cost is that a
     * plate on a car in the far background is not screened.
     */
    const val PLATE_MIN_WIDTH_RATIO = 0.03

    /**
     * Absolute minimum region height in pixels, independent of image size.
     *
     * Below roughly a dozen pixels of glyph height, plate characters are not
     * legible at capture resolution, so masking buys no privacy while the
     * false-positive cost stays real. The relative width test above cannot
     * express this on its own: on a small image, 3% of the width is a handful
     * of pixels. UNVALIDATED against real captures — verify on device.
     */
    const val PLATE_MIN_HEIGHT_PX = 12

    /**
     * Minimum region area as a fraction of image area (0.01%).
     *
     * A backstop, not a primary filter. It rejects the hairline region that
     * passes the width test but is one or two pixels tall in a large image —
     * geometry that satisfies every ratio above yet contains no readable
     * anything.
     */
    const val PLATE_MIN_AREA_RATIO = 0.0001

    // Padding deliberately REUSES the face constants (DEFAULT_PADDING_RATIO and
    // the MIN/MAX bounds). ML Kit's box wraps the glyphs, and the glyphs are
    // what identify the vehicle, so the same proportional margin that covers a
    // face box's slop covers a plate's. A caller that wants the plate's frame
    // and mounting covered too can raise paddingRatio within the same bounds.
}
