package com.kscan.glasses.bridge

enum class BridgeMessageType {
    HELLO,
    DEVICE_STATE,
    REQUEST_PERMISSIONS,
    PERMISSIONS_RESULT,
    CAPTURE_PHOTO,
    PHOTO_CAPTURED,
    PHOTO_ERROR,
    ANALYSIS_STARTED,
    ANALYSIS_RESULT,
    SAVE_ITEM,
    OPEN_ON_PHONE,
    AUTH_SESSION,
    ERROR,
}
