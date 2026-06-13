package com.kscan.glasses.bridge

data class PermissionState(
    val cameraGranted: Boolean,
    val microphoneGranted: Boolean,
    val bluetoothGranted: Boolean,
    val notificationsGranted: Boolean,
    val allRequiredGranted: Boolean,
)
