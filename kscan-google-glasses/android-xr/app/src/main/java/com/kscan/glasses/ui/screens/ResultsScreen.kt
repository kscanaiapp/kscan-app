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
import com.kscan.glasses.state.ProductMatch
import com.kscan.glasses.ui.components.FocusableCard
import com.kscan.glasses.ui.components.ResultCard
import com.kscan.glasses.ui.components.ResultSummary
import com.kscan.glasses.ui.components.VoiceHint

private val resultActions = listOf("Save", "Open on Phone", "Scan Again")

@Composable
fun ResultsScreen(
    summary: String,
    products: List<ProductMatch>,
    focusedIndex: Int,
    pageLabel: String?,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
    ) {
        Text(
            text = "Top Matches",
            color = Color(0xFF00E5FF),
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
        )
        pageLabel?.let {
            Text(text = it, color = Color(0xFFE0E0E8).copy(alpha = 0.6f), fontSize = 14.sp)
        }
        if (summary.isNotBlank()) {
            ResultSummary(summary)
        }
        products.forEachIndexed { index, product ->
            ResultCard(
                product = product,
                rank = index + 1,
                focused = focusedIndex == index,
            )
        }
        val actionOffset = products.size
        Text(
            text = "Actions",
            color = Color(0xFFE0E0E8),
            fontSize = 18.sp,
            modifier = Modifier.padding(top = 8.dp),
        )
        resultActions.forEachIndexed { index, action ->
            FocusableCard(
                title = action,
                focused = focusedIndex == actionOffset + index,
            )
        }
        VoiceHint("Up/Down to focus · Select to activate")
    }
}
