package com.kscan.glasses.phonebridge.mock

/**
 * Named on-device scenarios for the mock phone companion, applied by the
 * debug-only MockScenarioReceiver during emulator validation.
 *
 * Every scenario maps to an existing companion capability — no new protocol
 * surface, no production behavior change. Unknown names return false.
 */
object MockCompanionScenarios {

    const val AUTOPILOT_ON = "autopilot_on"
    const val AUTOPILOT_OFF = "autopilot_off"
    const val PAIR_DENY = "pair_deny"
    const val PAIR_APPROVE = "pair_approve"
    const val PAIR_HOLD = "pair_hold"
    const val PAIR_EXPIRE = "pair_expire"
    const val SESSION_REVOKE = "session_revoke"
    const val CONNECTION_LOST = "connection_lost"
    const val CONNECTION_RESTORED = "connection_restored"
    const val SCAN_FAIL_NEXT = "scan_fail_next"
    const val SCAN_DUPLICATE_NEXT = "scan_duplicate_next"
    const val SCAN_HOLD_NEXT = "scan_hold_next"
    const val STALE_ERROR = "stale_error"
    const val WRONG_DEVICE = "wrong_device"
    const val RESPONSIVE_OFF = "responsive_off"
    const val RESPONSIVE_ON = "responsive_on"

    /** Applies [scenario] to [companion]; false when the name is unknown. */
    suspend fun apply(companion: MockPhoneCompanion, scenario: String): Boolean = when (scenario) {
        AUTOPILOT_ON -> { companion.autopilot = true; true }
        AUTOPILOT_OFF -> { companion.autopilot = false; true }
        PAIR_DENY -> { companion.pairBehavior = MockPhoneCompanion.PairBehavior.DENY; true }
        PAIR_APPROVE -> { companion.pairBehavior = MockPhoneCompanion.PairBehavior.APPROVE; true }
        PAIR_HOLD -> { companion.pairBehavior = MockPhoneCompanion.PairBehavior.HOLD_UNTIL_EXPIRY; true }
        PAIR_EXPIRE -> { companion.expireHeldPairRequest(); true }
        SESSION_REVOKE -> { companion.revokeSession(); true }
        CONNECTION_LOST -> { companion.sendConnectionLost(); true }
        CONNECTION_RESTORED -> { companion.sendConnectionRestored(); true }
        SCAN_FAIL_NEXT -> { companion.failNextScan = true; true }
        SCAN_DUPLICATE_NEXT -> { companion.duplicateNextCompletion = true; true }
        SCAN_HOLD_NEXT -> { companion.holdNextScan = true; true }
        STALE_ERROR -> { companion.sendStaleSessionError(); true }
        WRONG_DEVICE -> { companion.sendWrongDeviceSessionError(); true }
        RESPONSIVE_OFF -> { companion.responsive = false; true }
        RESPONSIVE_ON -> { companion.responsive = true; true }
        else -> false
    }
}
