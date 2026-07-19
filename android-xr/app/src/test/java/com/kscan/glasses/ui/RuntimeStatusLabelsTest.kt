package com.kscan.glasses.ui

import com.kscan.glasses.runtime.GlassesRuntimeState
import com.kscan.glasses.runtime.RuntimeStatus
import com.kscan.glasses.ui.components.RuntimeStatusLabels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeStatusLabelsTest {

    @Test
    fun `mock development header is ALPHA MOCK HW VALIDATION PENDING`() {
        val label = RuntimeStatusLabels.headerLabel(
            RuntimeStatus(GlassesRuntimeState.MOCK_DEVELOPMENT, mock = true),
        )
        assertEquals("ALPHA • MOCK • HW VALIDATION PENDING", label)
    }

    @Test
    fun `privacy blocked header keeps ALPHA and HW pending and names privacy`() {
        val label = RuntimeStatusLabels.headerLabel(
            RuntimeStatus(GlassesRuntimeState.PRIVACY_BLOCKED, mock = false),
        )
        assertEquals("ALPHA • PRIVACY BLOCKED • HW VALIDATION PENDING", label)
    }

    @Test
    fun `configuration required header says setup required`() {
        val label = RuntimeStatusLabels.headerLabel(
            RuntimeStatus(GlassesRuntimeState.CONFIGURATION_REQUIRED, mock = false),
        )
        assertEquals("ALPHA • SETUP REQUIRED • HW VALIDATION PENDING", label)
    }

    @Test
    fun `dry run ready header says dry run ready`() {
        val label = RuntimeStatusLabels.headerLabel(
            RuntimeStatus(GlassesRuntimeState.DRY_RUN_READY, mock = false),
        )
        assertEquals("ALPHA • DRY RUN READY • HW VALIDATION PENDING", label)
    }

    @Test
    fun `mock indicator appears whenever any mock component is active`() {
        val label = RuntimeStatusLabels.headerLabel(
            RuntimeStatus(GlassesRuntimeState.PRIVACY_BLOCKED, mock = true),
        )
        assertTrue(label.contains("MOCK"))
        assertTrue(label.contains("PRIVACY BLOCKED"))
        assertTrue(label.contains("HW VALIDATION PENDING"))
    }

    @Test
    fun `unreachable LIVE_ANALYSIS_AUTHORIZED renders as configuration error never as authorized`() {
        val label = RuntimeStatusLabels.headerLabel(
            RuntimeStatus(GlassesRuntimeState.LIVE_ANALYSIS_AUTHORIZED, mock = false),
        )
        assertTrue(label.contains("CONFIGURATION ERROR"))
        assertTrue(!label.contains("LIVE"))
    }

    @Test
    fun `mock results are labeled as synthetic demo data`() {
        val badge = RuntimeStatusLabels.resultsMockBadge(
            RuntimeStatus(GlassesRuntimeState.MOCK_DEVELOPMENT, mock = true),
        )
        assertTrue(badge != null && badge.contains("MOCK RESULTS"))
        assertTrue(badge!!.contains("synthetic"))
    }

    @Test
    fun `non-mock results carry no mock badge`() {
        assertNull(
            RuntimeStatusLabels.resultsMockBadge(
                RuntimeStatus(GlassesRuntimeState.PRIVACY_BLOCKED, mock = false),
            ),
        )
    }
}
