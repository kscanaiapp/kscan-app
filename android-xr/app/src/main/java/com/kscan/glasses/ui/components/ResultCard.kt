package com.kscan.glasses.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kscan.glasses.state.ProductMatch

private val Chrome = Color(0xFFE0E0E8)

@Composable
fun ResultCard(
    product: ProductMatch,
    rank: Int,
    focused: Boolean,
    modifier: Modifier = Modifier,
) {
    FocusableCard(
        title = "#$rank ${product.name}",
        subtitle = "${product.retailer} · ${product.price}",
        focused = focused,
        modifier = modifier.padding(vertical = 4.dp),
        compact = true,
    )
}

@Composable
fun ResultSummary(text: String) {
    Text(
        text = text,
        color = Chrome.copy(alpha = 0.85f),
        fontSize = 16.sp,
        maxLines = 2,
        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp),
    )
}
