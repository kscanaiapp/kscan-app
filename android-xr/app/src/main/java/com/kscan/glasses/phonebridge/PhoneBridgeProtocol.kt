package com.kscan.glasses.phonebridge

/**
 * Versioned Google XR phone bridge protocol — canonical constants and enums.
 *
 * Authority model: the PHONE is the authority (auth, account, capture, scan
 * lifecycle, backend, results, session approval/revocation). Glasses own
 * pairing display, connection status, scan trigger, processing display,
 * result rendering, focus/D-pad, outbound actions, safe disconnect/recovery.
 *
 * RESULT-FIRST: no camera images, no base64 image payloads, no raw bytes ever
 * cross this bridge. Structured result data only.
 *
 * Legacy mapping (pre-versioned `bridge/` + `shared/bridge.schema.json`) lives
 * in docs/google/PHONE_BRIDGE_PROTOCOL.md.
 */
object PhoneBridgeProtocol {
    /** Only version this build understands. Unknown versions fail closed. */
    const val PROTOCOL_VERSION: Int = 1

    /**
     * Exact wire ceiling: 64 KiB (65,536 bytes UTF-8). Any frame larger than
     * this is rejected BEFORE parsing/rendering. Chosen well below the 100 KB
     * hard product limit to leave framing headroom for future fields.
     */
    const val MAX_MESSAGE_BYTES: Int = 65_536

    /**
     * Clock-skew tolerance for timestamp freshness checks. A message whose
     * timestamp is more than this far from local time (past or future) is
     * STALE_MESSAGE. Message-level `expiresAt` in the past is also stale.
     */
    const val TIMESTAMP_TOLERANCE_MS: Long = 30_000L

    /**
     * Maximum granted session lifetime accepted from `pair.approved`.
     * Approvals that expire at or before the message timestamp, or that grant
     * more than this window, are `INVALID_MESSAGE`.
     */
    const val MAX_SESSION_DURATION_MS: Long = 24L * 60L * 60L * 1_000L

    /** sessionId is empty ONLY for pair.request (no session exists yet). */
    const val NO_SESSION: String = ""

    // Wire messageType discriminator values (stable, dot-namespaced by family).

    const val TYPE_PAIR_REQUEST: String = "pair.request"
    const val TYPE_PAIR_APPROVED: String = "pair.approved"
    const val TYPE_PAIR_DENIED: String = "pair.denied"
    const val TYPE_PAIR_EXPIRED: String = "pair.expired"

    const val TYPE_SESSION_READY: String = "session.ready"
    const val TYPE_SESSION_REVOKED: String = "session.revoked"
    const val TYPE_SESSION_ERROR: String = "session.error"

    const val TYPE_CAPTURE_REQUEST: String = "capture.request"
    const val TYPE_CAPTURE_STARTED: String = "capture.started"
    const val TYPE_CAPTURE_COMPLETED: String = "capture.completed"
    const val TYPE_CAPTURE_FAILED: String = "capture.failed"

    const val TYPE_SCAN_PROCESSING: String = "scan.processing"
    const val TYPE_SCAN_PROGRESS: String = "scan.progress"
    const val TYPE_SCAN_COMPLETED: String = "scan.completed"
    const val TYPE_SCAN_FAILED: String = "scan.failed"

    const val TYPE_RESULT_SHOW: String = "result.show"
    const val TYPE_RESULT_UPDATE: String = "result.update"
    const val TYPE_RESULT_DISMISS: String = "result.dismiss"

    const val TYPE_ACTION_SAVE: String = "action.save"
    const val TYPE_ACTION_OPEN_ON_PHONE: String = "action.open_on_phone"
    const val TYPE_ACTION_RETRY: String = "action.retry"
    const val TYPE_ACTION_CANCEL: String = "action.cancel"

    const val TYPE_CONNECTION_PING: String = "connection.ping"
    const val TYPE_CONNECTION_PONG: String = "connection.pong"
    const val TYPE_CONNECTION_LOST: String = "connection.lost"
    const val TYPE_CONNECTION_RESTORED: String = "connection.restored"
}

/** Stable, HUD-safe rejection codes. Never carry payload text or exceptions. */
enum class BridgeRejectCode {
    UNSUPPORTED_PROTOCOL,
    INVALID_MESSAGE,
    MISSING_REQUEST_ID,
    SESSION_NOT_READY,
    SESSION_EXPIRED,
    SESSION_REVOKED,
    WRONG_DEVICE,
    STALE_MESSAGE,
    DUPLICATE_EVENT,
    PAYLOAD_TOO_LARGE,
    UNSUPPORTED_MESSAGE_TYPE,
    BRIDGE_UNAVAILABLE,
    CONNECTION_LOST,
}

enum class PairDenyReason { USER_REJECTED, BUSY, POLICY }

enum class SessionRevokeReason { USER_REVOKED, EXPIRED, REPLACED, ERROR }

enum class CapturePreference { GLASSES, PHONE, AUTO }

/** Phone-side scan pipeline stages surfaced as progress on glasses. */
enum class ScanStage { PRIVACY_PROCESSING, ANALYZING, MATCHING }

/** Scan status carried by result payloads (never claimed live unless COMPLETED). */
enum class ScanStatus { COMPLETED, PARTIAL, FAILED }

/** Retail vs resale grouping for a product match. */
enum class RetailGroup { RETAIL, RESALE }

/** Actions the phone offers on a result; glasses may only invoke offered ones. */
enum class ResultAction { SAVE, OPEN_ON_PHONE, RETRY, CANCEL }

enum class ConnectionLostReason { TRANSPORT_LOST, TIMEOUT, PEER_CLOSED }
