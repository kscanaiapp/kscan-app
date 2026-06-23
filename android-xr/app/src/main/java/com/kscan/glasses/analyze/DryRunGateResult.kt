package com.kscan.glasses.analyze

/**
 * Outcome of the controlled backend analyze dry-run gate.
 *
 * No payloads, URLs, tokens, or raw exception messages are included.
 */
sealed class DryRunGateResult {
    object Ready : DryRunGateResult()
    data class ConfigBlocked(val gate: String) : DryRunGateResult()
    data class Blocked(val gate: String) : DryRunGateResult()
}
