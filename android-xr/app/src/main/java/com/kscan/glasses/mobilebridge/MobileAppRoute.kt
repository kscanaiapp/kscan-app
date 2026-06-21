package com.kscan.glasses.mobilebridge

/**
 * Validated deep-link route enum for mobile app handoff.
 */
enum class MobileAppRoute(val path: String) {
    HANDOFF_RESULT("kscan://glasses/handoff/result/"),
    HANDOFF_SAVE("kscan://glasses/handoff/save/"),
    HANDOFF_OPEN("kscan://glasses/handoff/open/"),
    SESSION_REQUEST("kscan://glasses/session/request");

    companion object {
        fun fromUri(uri: String): MobileAppRoute? {
            return values().find { uri.startsWith(it.path) }
        }

        fun isValid(uri: String): Boolean = fromUri(uri) != null
    }
}
