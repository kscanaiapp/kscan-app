package com.kscan.glasses.navigation

sealed class GlassesInput {
    data object Up : GlassesInput()
    data object Down : GlassesInput()
    data object Left : GlassesInput()
    data object Right : GlassesInput()
    data object Select : GlassesInput()
    data object Back : GlassesInput()
    data object ScanShortcut : GlassesInput()
    data class VoiceCommand(val transcript: String) : GlassesInput()
}

class FocusNavigator(
    private val itemCount: () -> Int,
    initialIndex: Int = 0,
) {
    var focusedIndex: Int = initialIndex
        private set

    fun onInput(input: GlassesInput): FocusEvent {
        val count = itemCount()
        if (count == 0) return FocusEvent.None

        return when (input) {
            is GlassesInput.Up -> {
                focusedIndex = if (focusedIndex <= 0) count - 1 else focusedIndex - 1
                FocusEvent.Moved(focusedIndex)
            }
            is GlassesInput.Down -> {
                focusedIndex = if (focusedIndex >= count - 1) 0 else focusedIndex + 1
                FocusEvent.Moved(focusedIndex)
            }
            is GlassesInput.Select -> FocusEvent.Activated(focusedIndex)
            is GlassesInput.Left, is GlassesInput.Back -> FocusEvent.Back
            is GlassesInput.Right -> FocusEvent.Moved(focusedIndex)
            is GlassesInput.ScanShortcut -> FocusEvent.Scan
            is GlassesInput.VoiceCommand -> FocusEvent.Voice(input.transcript)
        }
    }

    fun reset(index: Int = 0) {
        focusedIndex = index.coerceAtLeast(0)
    }
}

sealed class FocusEvent {
    data object None : FocusEvent()
    data class Moved(val index: Int) : FocusEvent()
    data class Activated(val index: Int) : FocusEvent()
    data object Back : FocusEvent()
    data object Scan : FocusEvent()
    data class Voice(val transcript: String) : FocusEvent()
}
