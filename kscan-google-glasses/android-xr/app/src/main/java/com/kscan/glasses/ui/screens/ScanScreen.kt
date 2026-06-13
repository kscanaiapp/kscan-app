package com.kscan.glasses.ui.screens

import androidx.compose.foundation.layout.Arrangement
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
import com.kscan.glasses.ui.components.StatusChip
import com.kscan.glasses.ui.components.VoiceHint

private val actions = listOf("Scan", "Library", "Settings")

@Composable
fun ScanScreen(
    focusedIndex: Int,
    isProcessing: Boolean,
    lastVoiceAction: String?,
    onSimulateVoice: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = "K Scan",
            color = Color(0xFF00E5FF),
            fontSize = 32.sp,
            fontWeight = FontWeight.Bold,
        )
        StatusChip(if (isProcessing) "Processing" else "Ready")
        Text(
            text = "See it. Say it. Get it.",
            color = Color(0xFFE0E0E8),
            fontSize = 18.sp,
        )
        VoiceHint("Say \"K Scan scan this\" or press C to scan")
        lastVoiceAction?.let {
            VoiceHint("Last voice: $it")
        }
        actions.forEachIndexed { index, label ->
            FocusableCard(
                title = label,
                subtitle = when (label) {
                    "Scan" -> "Capture and analyze fashion"
                    "Library" -> "Saved looks on phone"
                    else -> "Mock mode & audio-only toggle"
                },
                focused = index == focusedIndex,
            )
        }
        VoiceHint("Mock: tap voice phrases in Settings")
    }
}
