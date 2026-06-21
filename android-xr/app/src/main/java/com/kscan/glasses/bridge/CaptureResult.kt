package com.kscan.glasses.bridge

data class CaptureResult(
    val base64: String,
    val mimeType: String,
    val source: CaptureSource,
)
