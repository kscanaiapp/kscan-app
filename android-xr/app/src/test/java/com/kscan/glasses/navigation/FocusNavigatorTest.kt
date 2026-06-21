package com.kscan.glasses.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FocusNavigatorTest {

    @Test
    fun `empty list returns None`() {
        val nav = FocusNavigator({ 0 })
        val event = nav.onInput(GlassesInput.Down)
        assertTrue(event is FocusEvent.None)
    }

    @Test
    fun `single item stays at index 0 on down`() {
        val nav = FocusNavigator({ 1 })
        val event = nav.onInput(GlassesInput.Down)
        assertTrue(event is FocusEvent.Moved)
        assertEquals(0, (event as FocusEvent.Moved).index)
    }

    @Test
    fun `down moves to next index`() {
        val nav = FocusNavigator({ 3 })
        nav.onInput(GlassesInput.Down)
        assertEquals(1, nav.focusedIndex)
    }

    @Test
    fun `up moves to previous index`() {
        val nav = FocusNavigator({ 3 }, initialIndex = 1)
        nav.onInput(GlassesInput.Up)
        assertEquals(0, nav.focusedIndex)
    }

    @Test
    fun `down wraps from last to first`() {
        val nav = FocusNavigator({ 3 }, initialIndex = 2)
        val event = nav.onInput(GlassesInput.Down)
        assertTrue(event is FocusEvent.Moved)
        assertEquals(0, nav.focusedIndex)
    }

    @Test
    fun `up wraps from first to last`() {
        val nav = FocusNavigator({ 3 }, initialIndex = 0)
        val event = nav.onInput(GlassesInput.Up)
        assertTrue(event is FocusEvent.Moved)
        assertEquals(2, nav.focusedIndex)
    }

    @Test
    fun `select emits Activated with current index`() {
        val nav = FocusNavigator({ 3 }, initialIndex = 1)
        val event = nav.onInput(GlassesInput.Select)
        assertTrue(event is FocusEvent.Activated)
        assertEquals(1, (event as FocusEvent.Activated).index)
    }

    @Test
    fun `back emits Back`() {
        val nav = FocusNavigator({ 3 })
        val event = nav.onInput(GlassesInput.Back)
        assertTrue(event is FocusEvent.Back)
    }

    @Test
    fun `left emits Back`() {
        val nav = FocusNavigator({ 3 })
        val event = nav.onInput(GlassesInput.Left)
        assertTrue(event is FocusEvent.Back)
    }

    @Test
    fun `right does not change index`() {
        val nav = FocusNavigator({ 3 }, initialIndex = 1)
        val event = nav.onInput(GlassesInput.Right)
        assertTrue(event is FocusEvent.Moved)
        assertEquals(1, nav.focusedIndex)
    }

    @Test
    fun `scan shortcut emits Scan`() {
        val nav = FocusNavigator({ 3 })
        val event = nav.onInput(GlassesInput.ScanShortcut)
        assertTrue(event is FocusEvent.Scan)
    }

    @Test
    fun `voice command passes transcript`() {
        val nav = FocusNavigator({ 3 })
        val event = nav.onInput(GlassesInput.VoiceCommand("test"))
        assertTrue(event is FocusEvent.Voice)
        assertEquals("test", (event as FocusEvent.Voice).transcript)
    }

    @Test
    fun `many items wrap correctly at boundaries`() {
        val nav = FocusNavigator({ 10 })
        repeat(10) { nav.onInput(GlassesInput.Down) }
        assertEquals(0, nav.focusedIndex)
    }

    @Test
    fun `reset sets index`() {
        val nav = FocusNavigator({ 5 }, initialIndex = 3)
        nav.reset(1)
        assertEquals(1, nav.focusedIndex)
    }

    @Test
    fun `reset clamps to zero when negative`() {
        val nav = FocusNavigator({ 5 }, initialIndex = 3)
        nav.reset(-1)
        assertEquals(0, nav.focusedIndex)
    }
}
