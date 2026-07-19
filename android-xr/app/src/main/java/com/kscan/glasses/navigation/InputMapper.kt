package com.kscan.glasses.navigation

import android.view.KeyEvent
import com.kscan.glasses.navigation.GlassesInput.Back
import com.kscan.glasses.navigation.GlassesInput.Down
import com.kscan.glasses.navigation.GlassesInput.Left
import com.kscan.glasses.navigation.GlassesInput.Right
import com.kscan.glasses.navigation.GlassesInput.ScanShortcut
import com.kscan.glasses.navigation.GlassesInput.Select
import com.kscan.glasses.navigation.GlassesInput.Up

object InputMapper {
    fun fromKeyEvent(keyCode: Int): GlassesInput? = when (keyCode) {
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_W -> Up
        KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_S -> Down
        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_A -> Left
        KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_D -> Right
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_SPACE -> Select
        KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_DEL, KeyEvent.KEYCODE_ESCAPE -> Back
        KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_CAMERA, KeyEvent.KEYCODE_C -> ScanShortcut
        else -> null
    }
}
