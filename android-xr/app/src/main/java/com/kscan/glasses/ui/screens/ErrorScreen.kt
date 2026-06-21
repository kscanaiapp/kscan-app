package com.kscan.glasses.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kscan.glasses.ui.components.FocusableCard
import com.kscan.glasses.ui.components.VoiceHint

@Composable
fun ErrorScreen(
    message: String,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
    ) {
        Text(
            text = "Error",
            color = Color(0xFFFF6B6B),
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = message,
            color = Color(0xFFE0E0E8),
            fontSize = 20.sp,
            modifier = Modifier.padding(vertical = 16.dp),
        )
        FocusableCard(
            title = "Retry",
            subtitle = "Select to try again",
            focused = true,
        )
        VoiceHint("Select or say K Scan go back")
    }
}
