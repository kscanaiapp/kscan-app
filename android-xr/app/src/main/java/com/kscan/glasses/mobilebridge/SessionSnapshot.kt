package com.kscan.glasses.mobilebridge

import com.kscan.glasses.bridge.BridgeMode

/**
 * Lightweight session state snapshot shared between glasses and phone.
 *
 * No tokens, no secrets, no user data.
 */
data class SessionSnapshot(
    val sessionId: String,
    val bridgeMode: BridgeMode,
    val lastActivityAtMs: Long? = null,
    val scanCount: Int = 0,
)
