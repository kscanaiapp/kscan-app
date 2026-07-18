package com.kscan.glasses.ui.components

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Chrome = Color(0xFFE0E0E8)
private val Cyan = Color(0xFF00E5FF)
private val Purple = Color(0xFF6B21A8)

@Composable
fun FocusableCard(
    title: String,
    subtitle: String? = null,
    focused: Boolean,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val borderColor = if (focused) Cyan else Purple.copy(alpha = 0.4f)
    // Compact variant keeps dense screens (e.g. Results) inside the 600dp HUD
    // viewport without dropping actions; default style is unchanged elsewhere.
    val contentPadding = if (compact) 10.dp else 16.dp
    val titleSize = if (compact) 18.sp else 22.sp
    val subtitleSize = if (compact) 14.sp else 16.sp
    Box(
        modifier = modifier
            .fillMaxWidth()
            .border(2.dp, borderColor, RoundedCornerShape(12.dp))
            .padding(contentPadding),
    ) {
        androidx.compose.foundation.layout.Column {
            Text(text = title, color = Chrome, fontSize = titleSize)
            if (subtitle != null) {
                Text(text = subtitle, color = Chrome.copy(alpha = 0.7f), fontSize = subtitleSize)
            }
        }
    }
}
