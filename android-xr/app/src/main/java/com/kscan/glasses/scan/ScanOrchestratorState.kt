package com.kscan.glasses.scan

/**
 * User-facing orchestrator states for HUD display.
 */
enum class ScanOrchestratorState {
    READY,
    PREPARING_IMAGE,
    PRIVACY_CHECK,
    ANALYZING_MOCK,
    BETA_ANALYZE_DISABLED,
    SAVE_OPEN_HANDOFF,
    ERROR_RETRY,
    COMPLETE,
}
