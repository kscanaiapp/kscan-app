package com.kscan.glasses.ui.components

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp

@Composable
fun VoiceHint(text: String) {
    Text(
        text = text,
        color = Color(0xFF00E5FF).copy(alpha = 0.75f),
        fontSize = 14.sp,
    )
}
