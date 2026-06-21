package com.kscan.glasses.state

enum class ScanStatus {
    IDLE,
    CAPTURING,
    SANITIZING,
    ANALYZING,
    COMPLETE,
    ERROR,
}

data class ScanSession(
    val id: String,
    val startedAtMs: Long,
    val captureSource: String? = null,
    val status: ScanStatus = ScanStatus.IDLE,
)
