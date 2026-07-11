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
}
