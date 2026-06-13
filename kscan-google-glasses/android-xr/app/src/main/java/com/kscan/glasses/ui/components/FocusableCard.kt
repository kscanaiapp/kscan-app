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
) {
    val borderColor = if (focused) Cyan else Purple.copy(alpha = 0.4f)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .border(2.dp, borderColor, RoundedCornerShape(12.dp))
            .padding(16.dp),
    ) {
        androidx.compose.foundation.layout.Column {
            Text(text = title, color = Chrome, fontSize = 22.sp)
            if (subtitle != null) {
                Text(text = subtitle, color = Chrome.copy(alpha = 0.7f), fontSize = 16.sp)
            }
        }
    }
}
