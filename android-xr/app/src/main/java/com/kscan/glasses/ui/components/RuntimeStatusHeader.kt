package com.kscan.glasses.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.kscan.glasses.runtime.GlassesRuntimeState
import com.kscan.glasses.runtime.RuntimeStatus

/**
 * Pure mapping from authoritative [RuntimeStatus] to HUD labels.
 *
 * UI honesty rules:
 * - Any mock component in the active pipeline -> persistent MOCK indicator.
 * - ALPHA and HW VALIDATION PENDING are always retained.
 * - Mock results must be labeled as synthetic demo data, never presented as
 *   authentic commerce output.
 * - LIVE_ANALYSIS_AUTHORIZED is unreachable in this build; if it ever appeared,
 *   it must surface as a configuration error, never as an authorized state.
 */
object RuntimeStatusLabels {
    const val ALPHA = "ALPHA"
    const val MOCK = "MOCK"
    const val HW_VALIDATION_PENDING = "HW VALIDATION PENDING"

    /** Concise single-line header for the 600×600 HUD. */
    fun headerLabel(status: RuntimeStatus): String {
        val segments = mutableListOf(ALPHA)
        if (status.mock) segments += MOCK
        when (status.state) {
            GlassesRuntimeState.MOCK_DEVELOPMENT -> Unit // MOCK segment already conveys it
            GlassesRuntimeState.PRIVACY_BLOCKED -> segments += "PRIVACY BLOCKED"
            GlassesRuntimeState.CONFIGURATION_REQUIRED -> segments += "SETUP REQUIRED"
            GlassesRuntimeState.DRY_RUN_READY -> segments += "DRY RUN READY"
            GlassesRuntimeState.LIVE_ANALYSIS_AUTHORIZED -> segments += "CONFIGURATION ERROR"
        }
        segments += HW_VALIDATION_PENDING
        return segments.joinToString(" • ")
    }

    /** Badge shown above results; non-null only when results come from a mock pipeline. */
    fun resultsMockBadge(status: RuntimeStatus): String? =
        if (status.mock) "MOCK RESULTS — synthetic demo data, not a real product match" else null
}

/**
 * Persistent status header rendered on every screen of the glasses HUD.
 */
@Composable
fun RuntimeStatusHeader(status: RuntimeStatus) {
    val accent = if (status.mock) Color(0xFFFFC857) else Color(0xFF00E5FF)
    StatusChip(
        label = RuntimeStatusLabels.headerLabel(status),
        accent = accent,
    )
}
