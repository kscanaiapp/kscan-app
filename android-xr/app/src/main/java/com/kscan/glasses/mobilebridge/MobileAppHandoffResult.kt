package com.kscan.glasses.mobilebridge

/**
 * Result payload for a handoff action from glasses to phone.
 *
 * Lightweight reference only — no image bytes, no base64, no full result data.
 */
data class MobileAppHandoffResult(
    val resultId: String,
    val action: HandoffAction,
    val route: MobileAppRoute,
)

enum class HandoffAction {
    SAVE,
    OPEN,
    SHARE,
}
