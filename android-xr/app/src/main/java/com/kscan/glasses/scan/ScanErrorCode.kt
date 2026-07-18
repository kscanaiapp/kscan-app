package com.kscan.glasses.scan

/**
 * Stable, user-safe error codes for the glasses scan pipeline.
 *
 * Codes are the machine-readable contract surfaced alongside the human-safe
 * HUD message. They never carry payload text, exception messages, file paths,
 * or backend-derived strings. Add new codes only for new stable categories —
 * never reuse an existing code for a different cause.
 */
enum class ScanErrorCode {
    /** Capture hardware/bridge unavailable or capture failed before the pipeline ran. */
    CAPTURE_UNAVAILABLE,

    /**
     * Strict privacy mode required but on-device masking is unavailable in this
     * build. The scan was NOT uploaded.
     */
    PRIVACY_UNAVAILABLE,

    /** Privacy sanitizer blocked the image before anything was uploaded. */
    PRIVACY_BLOCKED,

    /** Image bytes could not be decoded at the safe output boundary. */
    IMAGE_DECODE_FAILED,

    /** Image could not be re-encoded into a new safe JPEG at the output boundary. */
    IMAGE_ENCODE_FAILED,

    /** Outgoing payload failed validation before upload. */
    PAYLOAD_INVALID,

    /** Required configuration (beta flags, backend URL, dry-run gates) is missing or blocked. */
    CONFIGURATION_REQUIRED,

    /** Backend unreachable, errored, or returned an unusable response. */
    BACKEND_UNAVAILABLE,

    /** Backend did not respond within the time budget. */
    BACKEND_TIMEOUT,

    /** Reserved for user/system cancellation. No producer in this build. */
    CANCELLED,

    /** Capture analyzed successfully but is not a fashion item. */
    NON_FASHION,

    /** Fallback for anything without a stable classification. */
    UNKNOWN_SAFE_ERROR,
}
