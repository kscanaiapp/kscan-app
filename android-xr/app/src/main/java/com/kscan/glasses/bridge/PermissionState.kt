package com.kscan.glasses.bridge

/**
 * Represents permission states required for glasses operation.
 *
 * Pure model — no Android PermissionManager calls, no transport.
 */
data class PermissionState(
    val cameraGranted: Boolean = false,
    val microphoneGranted: Boolean = false,
    val locationGranted: Boolean = false,
    val storageGranted: Boolean = false,
    val notificationGranted: Boolean = false
) {
    val allGranted: Boolean
        get() = cameraGranted && microphoneGranted && locationGranted && storageGranted && notificationGranted

    val anyDenied: Boolean
        get() = !cameraGranted || !microphoneGranted || !locationGranted || !storageGranted || !notificationGranted

    companion object {
        fun default(): PermissionState = PermissionState()

        fun allGranted(): PermissionState = PermissionState(
            cameraGranted = true,
            microphoneGranted = true,
            locationGranted = true,
            storageGranted = true,
            notificationGranted = true
        )
    }
}
