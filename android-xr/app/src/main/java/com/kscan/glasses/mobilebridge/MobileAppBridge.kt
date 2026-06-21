package com.kscan.glasses.mobilebridge

/**
 * Interface for mobile app bridge operations.
 *
 * Pure contract — no transport, no real intents, no dependency on main mobile app repo.
 */
interface MobileAppBridge {

    /** Send a save request to the phone companion app. */
    suspend fun requestSave(itemId: String, label: String): MobileAppBridgeResult

    /** Request the phone to open a detailed result view. */
    suspend fun requestOpen(resultId: String): MobileAppBridgeResult

    /** Request current session snapshot from the phone. */
    suspend fun requestSessionSnapshot(): SessionSnapshot?

    /** Build a deep-link URI for a handoff route. */
    fun buildHandoffUri(route: MobileAppRoute): String

    /** Validate that a route string is recognized. */
    fun validateRoute(route: String): MobileAppRoute?
}

sealed class MobileAppBridgeResult {
    data class Success(val message: String = "ok") : MobileAppBridgeResult()
    data class Failure(val code: String, val reason: String) : MobileAppBridgeResult()
}
