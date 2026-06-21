package com.kscan.glasses.voice

/**
 * Voice activation mode.
 *
 * PUSH_TO_TALK only in Phase 2. No always-on listening.
 */
enum class VoiceActivationMode {
    PUSH_TO_TALK,
    ALWAYS_ON,
    DISABLED,
}
