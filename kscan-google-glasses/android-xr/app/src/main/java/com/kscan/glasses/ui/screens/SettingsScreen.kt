package com.kscan.glasses.ui.screens

import androidx.compose.foundation.clickable
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

private val voiceSamples = listOf(
    "K Scan scan this",
    "K Scan what am I looking at",
    "K Scan save this",
    "K Scan open on phone",
)

@Composable
fun SettingsScreen(
    hasDisplay: Boolean,
    onToggleAudioOnly: (Boolean) -> Unit,
    onSimulateVoice: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
    ) {
        Text(
            text = "Settings",
            color = Color(0xFF00E5FF),
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
        )
        FocusableCard(
            title = if (hasDisplay) "Display glasses (mock)" else "Audio-only (mock)",
            subtitle = "Tap to toggle capability mock",
            focused = true,
            modifier = Modifier
                .padding(vertical = 8.dp)
                .clickable { onToggleAudioOnly(hasDisplay) },
        )
        Text(
            text = "Mock voice commands",
            color = Color(0xFFE0E0E8),
            fontSize = 18.sp,
            modifier = Modifier.padding(top = 12.dp),
        )
        voiceSamples.forEach { phrase ->
            Text(
                text = "· $phrase",
                color = Color(0xFFE0E0E8).copy(alpha = 0.8f),
                fontSize = 16.sp,
                modifier = Modifier
                    .padding(vertical = 4.dp)
                    .clickable { onSimulateVoice(phrase) },
            )
        }
        VoiceHint("Always-on wake word not supported in alpha")
        VoiceHint("Back to return")
    }
}
