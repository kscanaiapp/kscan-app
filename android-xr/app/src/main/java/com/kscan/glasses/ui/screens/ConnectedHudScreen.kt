package com.kscan.glasses.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kscan.glasses.phonebridge.PhoneBridgeProviderStatus
import com.kscan.glasses.phonebridge.ResultProduct
import com.kscan.glasses.phonebridge.SessionRevokeReason
import com.kscan.glasses.runtime.ConnectedAction
import com.kscan.glasses.runtime.ConnectedState
import com.kscan.glasses.runtime.ConnectedUiState
import com.kscan.glasses.runtime.ProgressKind
import com.kscan.glasses.state.ConnectedFocusItem
import com.kscan.glasses.state.KScanViewModel
import com.kscan.glasses.ui.components.FocusableCard
import com.kscan.glasses.ui.components.StatusChip

private val Chrome = Color(0xFFE0E0E8)
private val Cyan = Color(0xFF00E5FF)
private val Purple = Color(0xFF6B21A8)
private val Amber = Color(0xFFFFC857)
private val ErrorRed = Color(0xFFFF5252)
private val OfflineGray = Color(0xFF8A8A94)

/**
 * Connected-runtime HUD: renders every [ConnectedState] from the machine's
 * metadata contract. True-black root, top-aligned, no scrolling — the compact
 * layout is budgeted to fit the 600dp glasses viewport even with a full
 * 5-product result stack. No voice indicator: the voice loop is phone-side.
 */
@Composable
fun ConnectedHudScreen(
    ui: ConnectedUiState,
    providerStatus: PhoneBridgeProviderStatus,
    focusItems: List<ConnectedFocusItem>,
    focusedIndex: Int,
    actionNotice: String?,
    pairingCode: String?,
    mockBadge: String?,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ConnectionIndicator(ui.state, providerStatus)
        Text(
            text = titleFor(ui),
            color = Cyan,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
        )
        if (mockBadge != null && (ui.state == ConnectedState.RESULTS || ui.state == ConnectedState.ACTION_CONFIRMED)) {
            // Mock results are always labeled as synthetic demo data.
            StatusChip(label = mockBadge, accent = Amber)
        }
        supportingCopy(ui)?.let {
            Text(
                text = it,
                color = Chrome.copy(alpha = 0.7f),
                fontSize = 14.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (ui.state == ConnectedState.PAIRING && pairingCode != null) {
            StatusChip(label = "PAIR CODE  $pairingCode", accent = Cyan)
        }
        when (ui.metadata.progress.kind) {
            ProgressKind.INDETERMINATE -> LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth(),
                color = Cyan,
                trackColor = Purple.copy(alpha = 0.3f),
            )
            ProgressKind.BOUNDED -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                LinearProgressIndicator(
                    progress = { (ui.progressPercent ?: 0) / 100f },
                    modifier = Modifier.weight(1f),
                    color = Cyan,
                    trackColor = Purple.copy(alpha = 0.3f),
                )
                Text(
                    text = "${ui.progressPercent ?: 0}%",
                    color = Chrome.copy(alpha = 0.7f),
                    fontSize = 14.sp,
                )
            }
            ProgressKind.NONE -> Unit
        }
        when (ui.state) {
            ConnectedState.RESULTS -> ResultStack(ui, focusItems, focusedIndex)
            ConnectedState.ACTION_CONFIRMED -> {
                StatusChip(label = confirmationLabel(ui), accent = Cyan)
                ActionCards(focusItems, focusedIndex, offset = 0)
            }
            ConnectedState.ERROR -> {
                ui.errorCode?.let { StatusChip(label = it, accent = ErrorRed) }
                ActionCards(focusItems, focusedIndex, offset = 0)
            }
            else -> ActionCards(focusItems, focusedIndex, offset = 0)
        }
        actionNotice?.let {
            StatusChip(label = it, accent = Amber)
        }
    }
}

/** Metadata title, except the confirmation card which keys on the confirmed action. */
private fun titleFor(ui: ConnectedUiState): String =
    if (ui.state == ConnectedState.ACTION_CONFIRMED && ui.confirmedAction == ConnectedAction.OPEN_ON_PHONE) {
        "Opening on phone"
    } else {
        ui.metadata.title
    }

private fun confirmationLabel(ui: ConnectedUiState): String =
    when (ui.confirmedAction) {
        ConnectedAction.OPEN_ON_PHONE -> "CONFIRMED — continuing on your phone"
        else -> "CONFIRMED — saved to your library"
    }

/** Supporting copy; skipped where the cards already carry the context. */
private fun supportingCopy(ui: ConnectedUiState): String? = when (ui.state) {
    ConnectedState.DISCONNECTED -> ui.disconnectReason?.let { reason ->
        when (reason) {
            SessionRevokeReason.EXPIRED -> "Session expired — pair again."
            SessionRevokeReason.USER_REVOKED -> "Session ended on your phone — pair again."
            SessionRevokeReason.REPLACED -> "Session replaced by another connection — pair again."
            SessionRevokeReason.ERROR -> "Session ended unexpectedly — pair again."
        }
    } ?: ui.metadata.supportingCopy
    ConnectedState.RESULTS, ConnectedState.ACTION_CONFIRMED -> null
    else -> ui.metadata.supportingCopy
}

/** Connection indicator row: dot + label, driven by state and provider status. */
@Composable
private fun ConnectionIndicator(state: ConnectedState, providerStatus: PhoneBridgeProviderStatus) {
    val (label, color) = when {
        providerStatus == PhoneBridgeProviderStatus.DISABLED -> "Phone bridge disabled" to OfflineGray
        state == ConnectedState.DISCONNECTED -> "Phone: not connected" to OfflineGray
        state == ConnectedState.PAIRING || state == ConnectedState.CONNECTED -> "Phone: pairing…" to Amber
        state == ConnectedState.RECONNECTING -> "Phone: reconnecting…" to Amber
        providerStatus == PhoneBridgeProviderStatus.ACTIVE -> "Phone: connected" to Cyan
        else -> "Phone: unavailable" to Amber
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .background(color, CircleShape),
        )
        Text(text = label, color = Chrome.copy(alpha = 0.8f), fontSize = 14.sp)
    }
}

/**
 * Primary result card (summary) plus the 3–5 product stack. Product rows are
 * slim single-line cards so the full stack plus three actions fits 600dp.
 */
@Composable
private fun ResultStack(
    ui: ConnectedUiState,
    focusItems: List<ConnectedFocusItem>,
    focusedIndex: Int,
) {
    val products = ui.result?.products.orEmpty().take(KScanViewModel.MAX_RESULT_ITEMS)
    ui.result?.summary?.takeIf { it.isNotBlank() }?.let {
        Text(
            text = it,
            color = Chrome,
            fontSize = 14.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
    products.forEachIndexed { index, product ->
        HudProductRow(
            product = product,
            focused = focusedIndex == index,
        )
    }
    ActionCards(focusItems, focusedIndex, offset = products.size)
}

/** Action/destination cards after the product rows; offset keeps focus indices aligned. */
@Composable
private fun ActionCards(
    focusItems: List<ConnectedFocusItem>,
    focusedIndex: Int,
    offset: Int,
) {
    focusItems.drop(offset).forEachIndexed { index, item ->
        FocusableCard(
            title = item.label,
            focused = focusedIndex == offset + index,
            compact = true,
        )
    }
}

/** Slim single-line product card for the 600dp result stack. */
@Composable
private fun HudProductRow(product: ResultProduct, focused: Boolean) {
    val borderColor = if (focused) Cyan else Purple.copy(alpha = 0.4f)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .border(2.dp, borderColor, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            text = "${product.title} — ${product.brand} · ${product.price} ${product.currency}",
            color = Chrome,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
