package com.kscan.glasses.navigation

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Key contract for glasses/emulator controls. android.view.KeyEvent key codes
 * are compile-time constants, so they are safe to reference in unit tests.
 */
class InputMapperTest {

    @Test
    fun `dpad arrows and WASD map to directions`() {
        assertEquals(GlassesInput.Up, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(GlassesInput.Up, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_W))
        assertEquals(GlassesInput.Down, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals(GlassesInput.Down, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_S))
        assertEquals(GlassesInput.Left, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals(GlassesInput.Left, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_A))
        assertEquals(GlassesInput.Right, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_DPAD_RIGHT))
        assertEquals(GlassesInput.Right, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_D))
    }

    @Test
    fun `enter space and dpad center map to select`() {
        assertEquals(GlassesInput.Select, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_ENTER))
        assertEquals(GlassesInput.Select, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_SPACE))
        assertEquals(GlassesInput.Select, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_DPAD_CENTER))
    }

    @Test
    fun `back backspace and escape map to back`() {
        assertEquals(GlassesInput.Back, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_BACK))
        assertEquals(GlassesInput.Back, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_DEL))
        assertEquals(GlassesInput.Back, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_ESCAPE))
    }

    @Test
    fun `scan shortcut keys map to scan`() {
        assertEquals(GlassesInput.ScanShortcut, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_C))
        assertEquals(GlassesInput.ScanShortcut, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_CAMERA))
        assertEquals(GlassesInput.ScanShortcut, InputMapper.fromKeyEvent(KeyEvent.KEYCODE_BUTTON_R1))
    }

    @Test
    fun `unmapped key returns null`() {
        assertNull(InputMapper.fromKeyEvent(KeyEvent.KEYCODE_VOLUME_UP))
    }
}
