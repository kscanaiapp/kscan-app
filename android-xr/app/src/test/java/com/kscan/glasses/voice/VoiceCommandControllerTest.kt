package com.kscan.glasses.voice

import com.kscan.glasses.navigation.GlassesInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceCommandControllerTest {

    private val parser = VoiceCommandController()

    @Test
    fun `'k scan' returns WAKE`() {
        val (action, input) = parser.parse("K Scan")
        assertEquals(VoiceAction.WAKE, action)
        assertNull(input)
    }

    @Test
    fun `'k scan scan this' returns SCAN`() {
        val (action, input) = parser.parse("K Scan scan this")
        assertEquals(VoiceAction.SCAN, action)
        assertEquals(GlassesInput.ScanShortcut, input)
    }

    @Test
    fun `'k scan scan' returns SCAN`() {
        val (action, input) = parser.parse("K Scan scan")
        assertEquals(VoiceAction.SCAN, action)
        assertEquals(GlassesInput.ScanShortcut, input)
    }

    @Test
    fun `'k scan what am i looking at' returns WHAT_AM_I_LOOKING_AT`() {
        val (action, input) = parser.parse("K Scan what am I looking at")
        assertEquals(VoiceAction.WHAT_AM_I_LOOKING_AT, action)
        assertEquals(GlassesInput.ScanShortcut, input)
    }

    @Test
    fun `'k scan find similar' returns FIND_SIMILAR`() {
        val (action, input) = parser.parse("K Scan find similar")
        assertEquals(VoiceAction.FIND_SIMILAR, action)
        assertEquals(GlassesInput.ScanShortcut, input)
    }

    @Test
    fun `'k scan save this' returns SAVE`() {
        val (action, input) = parser.parse("K Scan save this")
        assertEquals(VoiceAction.SAVE, action)
        assertEquals(GlassesInput.Select, input)
    }

    @Test
    fun `'k scan save' returns SAVE`() {
        val (action, input) = parser.parse("K Scan save")
        assertEquals(VoiceAction.SAVE, action)
        assertEquals(GlassesInput.Select, input)
    }

    @Test
    fun `'k scan next' returns NEXT`() {
        val (action, input) = parser.parse("K Scan next")
        assertEquals(VoiceAction.NEXT, action)
        assertEquals(GlassesInput.Down, input)
    }

    @Test
    fun `'k scan previous' returns PREVIOUS`() {
        val (action, input) = parser.parse("K Scan previous")
        assertEquals(VoiceAction.PREVIOUS, action)
        assertEquals(GlassesInput.Up, input)
    }

    @Test
    fun `'k scan prev' returns PREVIOUS`() {
        val (action, input) = parser.parse("K Scan prev")
        assertEquals(VoiceAction.PREVIOUS, action)
        assertEquals(GlassesInput.Up, input)
    }

    @Test
    fun `'k scan open on phone' returns OPEN_ON_PHONE`() {
        val (action, input) = parser.parse("K Scan open on phone")
        assertEquals(VoiceAction.OPEN_ON_PHONE, action)
        assertEquals(GlassesInput.Select, input)
    }

    @Test
    fun `'k scan go back' returns GO_BACK`() {
        val (action, input) = parser.parse("K Scan go back")
        assertEquals(VoiceAction.GO_BACK, action)
        assertEquals(GlassesInput.Back, input)
    }

    @Test
    fun `'k scan back' returns GO_BACK`() {
        val (action, input) = parser.parse("K Scan back")
        assertEquals(VoiceAction.GO_BACK, action)
        assertEquals(GlassesInput.Back, input)
    }

    @Test
    fun `irrelevant phrase returns UNKNOWN`() {
        val (action, input) = parser.parse("What is the weather today")
        assertEquals(VoiceAction.UNKNOWN, action)
        assertNull(input)
    }

    @Test
    fun `partial match without k scan prefix returns UNKNOWN`() {
        val (action, input) = parser.parse("scan this")
        assertEquals(VoiceAction.UNKNOWN, action)
        assertNull(input)
    }
}
