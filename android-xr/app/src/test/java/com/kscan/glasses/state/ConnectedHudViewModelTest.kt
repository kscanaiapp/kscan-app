package com.kscan.glasses.state

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.navigation.GlassesInput
import com.kscan.glasses.phonebridge.DisabledPhoneBridgeProvider
import com.kscan.glasses.phonebridge.SessionRevokeReason
import com.kscan.glasses.phonebridge.mock.MockPhoneBridgeProvider
import com.kscan.glasses.phonebridge.mock.MockPhoneCompanion
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.runtime.ConnectedAction
import com.kscan.glasses.runtime.ConnectedState
import com.kscan.glasses.scan.ScanErrorCode
import com.kscan.glasses.scan.ScanOrchestrator
import com.kscan.glasses.testing.MainDispatcherRule
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * End-to-end connected-mode coverage: provider events drive the machine, the
 * ViewModel executes effects against the mock companion, and the HUD focus
 * model follows the metadata contract. Everything runs on the rule's test
 * dispatcher, so the glasses→phone→glasses loopback is fully synchronous.
 *
 * Key honesty invariant: the HUD NEVER shows an optimistic "Saved" — the
 * confirmation state is reachable only through the companion's result.update.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ConnectedHudViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private companion object {
        const val T0 = 1_700_000_000_000L
    }

    private fun connectedViewModel(
        pairBehavior: MockPhoneCompanion.PairBehavior = MockPhoneCompanion.PairBehavior.APPROVE,
        ackTimeoutMs: Long = KScanViewModel.DEFAULT_ACK_TIMEOUT_MS,
    ): Pair<KScanViewModel, MockPhoneBridgeProvider> {
        val provider = MockPhoneBridgeProvider.create(
            parentScope = CoroutineScope(SupervisorJob() + mainDispatcherRule.testDispatcher),
            clock = { T0 },
            pairBehavior = pairBehavior,
        )
        val orchestrator = ScanOrchestrator(
            sanitizer = mockk<PrivacyImageSanitizer>(relaxed = true),
            analyzeClient = mockk<AnalyzeClient>(relaxed = true),
            phoneBridge = DisabledPhoneBridgeProvider(),
            config = BetaConfig.DEFAULT,
            ioDispatcher = UnconfinedTestDispatcher(),
        )
        return KScanViewModel(
            bridge = MockBridgeProvider(),
            orchestrator = orchestrator,
            phoneBridge = provider,
            ackTimeoutMs = ackTimeoutMs,
        ) to provider
    }

    private fun ui(vm: KScanViewModel) = vm.connected.value!!
    private fun state(vm: KScanViewModel) = ui(vm).state
    private fun labels(vm: KScanViewModel) = vm.connectedItems.value.map { it.label }

    private fun assertFocusContract(vm: KScanViewModel) {
        assertTrue("every state exposes at least one focus row", labels(vm).isNotEmpty())
        assertTrue("no dead focus nodes", labels(vm).all { it.isNotBlank() })
        assertTrue("focus index inside the list", vm.focusedIndex() in labels(vm).indices)
    }

    private fun driveToReady(vm: KScanViewModel, provider: MockPhoneBridgeProvider) {
        vm.onInput(GlassesInput.Select) // "Pair phone" is the DISCONNECTED default focus
        runBlocking { provider.companion.sendSessionReady() }
        assertEquals(ConnectedState.READY, state(vm))
    }

    /** RESULTS with the canonical two-product fixture. */
    private fun driveToResults(vm: KScanViewModel, provider: MockPhoneBridgeProvider) {
        driveToReady(vm, provider)
        vm.onInput(GlassesInput.ScanShortcut)
        assertEquals(ConnectedState.PRIVACY_PROCESSING, state(vm))
        runBlocking {
            provider.companion.sendScanSequence("scan-1", "res-1")
            provider.companion.sendResultShow("res-1")
        }
        assertEquals(ConnectedState.RESULTS, state(vm))
        assertEquals("res-1", ui(vm).result?.resultId)
    }

    // ----- composition -----

    @Test
    fun `connected mode roots the app at the connected hud`() {
        val (vm, _) = connectedViewModel()

        assertEquals(AppScreen.CONNECTED, vm.screen.value)
        assertEquals(ConnectedState.DISCONNECTED, state(vm))
        assertFocusContract(vm)
    }

    // ----- happy path -----

    @Test
    fun `full connected flow pairs scans saves and confirms via ack`() {
        val (vm, provider) = connectedViewModel()
        driveToResults(vm, provider)

        // Metadata default focus in RESULTS is Save (after the two products).
        assertEquals(2, vm.focusedIndex())
        vm.onInput(GlassesInput.Select)

        assertEquals(ConnectedState.ACTION_CONFIRMED, state(vm))
        assertEquals(ConnectedAction.SAVE, ui(vm).confirmedAction)
        assertEquals(listOf("Done"), labels(vm))

        vm.onInput(GlassesInput.Select) // Done
        assertEquals(ConnectedState.READY, state(vm))
        assertNull(ui(vm).result)
        assertNull(ui(vm).confirmedAction)
    }

    @Test
    fun `open on phone confirms with the open action`() {
        val (vm, provider) = connectedViewModel()
        driveToResults(vm, provider)

        vm.onInput(GlassesInput.Down) // 3 = "Open on phone"
        vm.onInput(GlassesInput.Select)

        assertEquals(ConnectedState.ACTION_CONFIRMED, state(vm))
        assertEquals(ConnectedAction.OPEN_ON_PHONE, ui(vm).confirmedAction)
    }

    // ----- pairing failures -----

    @Test
    fun `pairing denied shows a retryable error`() {
        val (vm, _) = connectedViewModel(pairBehavior = MockPhoneCompanion.PairBehavior.DENY)

        vm.onInput(GlassesInput.Select)

        assertEquals(ConnectedState.ERROR, state(vm))
        assertEquals("PAIRING_DENIED", ui(vm).errorCode)
        assertEquals(listOf("Retry", "Dismiss"), labels(vm))
        assertEquals(0, vm.focusedIndex())
        assertFocusContract(vm)
    }

    @Test
    fun `pairing held until expiry shows pairing expired`() {
        val (vm, provider) = connectedViewModel(pairBehavior = MockPhoneCompanion.PairBehavior.HOLD_UNTIL_EXPIRY)

        vm.onInput(GlassesInput.Select)
        assertEquals(ConnectedState.PAIRING, state(vm))
        assertEquals(listOf("Cancel"), labels(vm))

        runBlocking { provider.companion.expireHeldPairRequest() }

        assertEquals(ConnectedState.ERROR, state(vm))
        assertEquals("PAIRING_EXPIRED", ui(vm).errorCode)
    }

    // ----- session lifecycle -----

    @Test
    fun `session revoked lands disconnected with the reason and re-pair clears it`() {
        val (vm, provider) = connectedViewModel()
        driveToReady(vm, provider)

        runBlocking { provider.companion.revokeSession(SessionRevokeReason.USER_REVOKED) }

        assertEquals(ConnectedState.DISCONNECTED, state(vm))
        assertEquals(SessionRevokeReason.USER_REVOKED, ui(vm).disconnectReason)
        assertEquals(listOf("Pair phone", "Closet", "Settings"), labels(vm))

        vm.onInput(GlassesInput.Select) // Pair again
        assertEquals(ConnectedState.CONNECTED, state(vm)) // mock auto-approves
        assertNull(ui(vm).disconnectReason)
    }

    @Test
    fun `connection lost and restored returns to results with default focus`() {
        val (vm, provider) = connectedViewModel()
        driveToResults(vm, provider)
        vm.onInput(GlassesInput.Down) // move focus away from the default
        assertEquals(3, vm.focusedIndex())

        runBlocking { provider.companion.sendConnectionLost() }
        assertEquals(ConnectedState.RECONNECTING, state(vm))
        assertEquals(listOf("Disconnect"), labels(vm))
        assertFocusContract(vm)

        runBlocking { provider.companion.sendConnectionRestored() }
        assertEquals(ConnectedState.RESULTS, state(vm))
        assertEquals("res-1", ui(vm).result?.resultId)
        // Focus is restored to the metadata default after the state change.
        assertEquals(2, vm.focusedIndex())
    }

    // ----- scan failures and recovery -----

    @Test
    fun `scan failed surfaces the safe code and retry returns ready`() {
        val (vm, provider) = connectedViewModel()
        driveToReady(vm, provider)
        vm.onInput(GlassesInput.ScanShortcut)
        runBlocking { provider.companion.sendScanProcessing("scan-1") }

        runBlocking { provider.companion.sendScanFailed("scan-1", ScanErrorCode.BACKEND_UNAVAILABLE) }

        assertEquals(ConnectedState.ERROR, state(vm))
        assertEquals(ScanErrorCode.BACKEND_UNAVAILABLE.name, ui(vm).errorCode)

        vm.onInput(GlassesInput.Select) // Retry (default focus)
        assertEquals(ConnectedState.READY, state(vm))
    }

    @Test
    fun `retry from results re-arms capture through the companion ack`() {
        val (vm, provider) = connectedViewModel()
        driveToResults(vm, provider)

        repeat(2) { vm.onInput(GlassesInput.Down) } // 4 = "Retry scan"
        vm.onInput(GlassesInput.Select)

        // The companion answers action.retry with scan.processing for a fresh scan.
        assertEquals(ConnectedState.PRIVACY_PROCESSING, state(vm))
        assertFocusContract(vm)
    }

    @Test
    fun `cancel mid scan returns ready and the late failure is ignored`() {
        val (vm, provider) = connectedViewModel()
        driveToReady(vm, provider)
        vm.onInput(GlassesInput.ScanShortcut)
        runBlocking { provider.companion.sendScanProcessing("scan-1") }
        assertEquals(ConnectedState.PRIVACY_PROCESSING, state(vm))

        // Back cancels; the companion answers action.cancel with a CANCELLED
        // scan.failed that must not disturb the returned READY state.
        vm.onInput(GlassesInput.Back)

        assertEquals(ConnectedState.READY, state(vm))
        assertNull(ui(vm).scanId)
        assertEquals(listOf("Scan", "Closet", "Settings"), labels(vm))
    }

    @Test
    fun `back from results returns ready`() {
        val (vm, provider) = connectedViewModel()
        driveToResults(vm, provider)

        vm.onInput(GlassesInput.Back)

        assertEquals(ConnectedState.READY, state(vm))
        assertNull(ui(vm).result)
    }

    // ----- duplicate / hostile traffic -----

    @Test
    fun `duplicate result show keeps a single result and stable focus`() {
        val (vm, provider) = connectedViewModel()
        driveToResults(vm, provider)
        assertEquals(2, vm.focusedIndex())

        runBlocking { provider.companion.sendResultShow("res-1") }

        assertEquals(ConnectedState.RESULTS, state(vm))
        assertEquals("res-1", ui(vm).result?.resultId)
        assertEquals(5, labels(vm).size)
        assertEquals(2, vm.focusedIndex())
    }

    @Test
    fun `stale and wrong-device frames never reach the machine`() {
        val (vm, provider) = connectedViewModel()
        driveToReady(vm, provider)

        runBlocking {
            provider.companion.sendStaleSessionError()
            provider.companion.sendWrongDeviceSessionError()
        }

        assertEquals(ConnectedState.READY, state(vm))
        assertNull(ui(vm).errorCode)
    }

    // ----- action acknowledgement honesty -----

    @Test
    fun `save confirmation waits for the companion ack`() {
        val (vm, provider) = connectedViewModel()
        driveToResults(vm, provider)

        // Link dead: the action leaves the glasses but no ack can arrive.
        provider.companion.responsive = false
        vm.onInput(GlassesInput.Select) // Save (default focus)

        assertEquals(ConnectedState.RESULTS, state(vm)) // NO optimistic confirmation
        assertNull(ui(vm).confirmedAction)

        provider.companion.responsive = true
        runBlocking { provider.companion.sendResultUpdate("res-1") }

        assertEquals(ConnectedState.ACTION_CONFIRMED, state(vm))
        assertEquals(ConnectedAction.SAVE, ui(vm).confirmedAction)
    }

    @Test
    fun `companion rejection surfaces an actionable error`() {
        val (vm, provider) = connectedViewModel()
        driveToResults(vm, provider)
        provider.companion.rejectActions = true

        vm.onInput(GlassesInput.Select) // Save

        assertEquals(ConnectedState.ERROR, state(vm))
        assertEquals(MockPhoneCompanion.REJECTED_ACTION_CODE, ui(vm).errorCode)
        assertEquals(listOf("Retry", "Dismiss"), labels(vm))

        vm.onInput(GlassesInput.Select) // Retry → recoverable, returns READY
        assertEquals(ConnectedState.READY, state(vm))
    }

    @Test
    fun `ack watchdog timeout surfaces action timeout`() {
        val (vm, provider) = connectedViewModel(ackTimeoutMs = 3_000L)
        driveToResults(vm, provider)

        provider.companion.responsive = false // ack will never arrive
        vm.onInput(GlassesInput.Select) // Save
        assertEquals(ConnectedState.RESULTS, state(vm))

        mainDispatcherRule.testDispatcher.scheduler.advanceTimeBy(3_001L)
        mainDispatcherRule.testDispatcher.scheduler.runCurrent()

        assertEquals(ConnectedState.ERROR, state(vm))
        assertEquals("ACTION_TIMEOUT", ui(vm).errorCode)

        vm.onInput(GlassesInput.Select) // Retry → READY
        assertEquals(ConnectedState.READY, state(vm))
    }

    // ----- focus contract -----

    @Test
    fun `focus order and default focus follow the metadata across states`() {
        val (vm, provider) = connectedViewModel()

        // DISCONNECTED: pair first, then overlay destinations.
        assertEquals(listOf("Pair phone", "Closet", "Settings"), labels(vm))
        assertEquals(0, vm.focusedIndex())
        assertFocusContract(vm)

        vm.onInput(GlassesInput.Select) // → PAIRING → CONNECTED (auto-approve)
        assertEquals(listOf("Cancel"), labels(vm))
        assertFocusContract(vm)

        runBlocking { provider.companion.sendSessionReady() } // → READY
        assertEquals(listOf("Scan", "Closet", "Settings"), labels(vm))
        assertEquals(0, vm.focusedIndex())
        assertFocusContract(vm)

        vm.onInput(GlassesInput.ScanShortcut) // → PRIVACY_PROCESSING
        assertEquals(listOf("Cancel"), labels(vm))
        assertFocusContract(vm)

        runBlocking {
            provider.companion.sendScanSequence("scan-1", "res-1")
            provider.companion.sendResultShow("res-1")
        }
        assertEquals(
            listOf(
                "Leather Biker Jacket — Saint Laurent",
                "Pre-owned Leather Jacket — Schott",
                "Save",
                "Open on phone",
                "Retry scan",
            ),
            labels(vm),
        )
        assertEquals(2, vm.focusedIndex()) // metadata default: SAVE
        assertFocusContract(vm)

        // D-pad navigation wraps; no index ever leaves the list.
        vm.onInput(GlassesInput.Down)
        vm.onInput(GlassesInput.Down)
        assertEquals(4, vm.focusedIndex())
        vm.onInput(GlassesInput.Down)
        assertEquals(0, vm.focusedIndex())
        vm.onInput(GlassesInput.Up)
        assertEquals(4, vm.focusedIndex())
    }

    @Test
    fun `scan shortcut only scans from ready`() {
        val (vm, provider) = connectedViewModel()

        vm.onInput(GlassesInput.ScanShortcut) // DISCONNECTED: ignored
        assertEquals(ConnectedState.DISCONNECTED, state(vm))

        driveToResults(vm, provider)
        vm.onInput(GlassesInput.ScanShortcut) // RESULTS: ignored
        assertEquals(ConnectedState.RESULTS, state(vm))

        vm.onInput(GlassesInput.Back) // → READY
        vm.onInput(GlassesInput.ScanShortcut)
        assertEquals(ConnectedState.PRIVACY_PROCESSING, state(vm))
    }

    // ----- overlays and voice -----

    @Test
    fun `closet and settings overlays round trip without touching the machine`() {
        val (vm, provider) = connectedViewModel()
        driveToReady(vm, provider)

        vm.onInput(GlassesInput.Down) // Closet
        vm.onInput(GlassesInput.Select)
        assertEquals(AppScreen.LIBRARY, vm.screen.value)
        vm.onInput(GlassesInput.Back)
        assertEquals(AppScreen.CONNECTED, vm.screen.value)
        assertEquals(ConnectedState.READY, state(vm))

        // Overlays don't touch the machine: focus is still on Closet (1).
        assertEquals(1, vm.focusedIndex())
        vm.onInput(GlassesInput.Down) // → Settings
        vm.onInput(GlassesInput.Select)
        assertEquals(AppScreen.SETTINGS, vm.screen.value)
        // The mock voice loop is legacy-only; hidden in connected mode.
        assertTrue(vm.settingsVoiceSamples.isEmpty())
        vm.onInput(GlassesInput.Back)
        assertEquals(AppScreen.CONNECTED, vm.screen.value)
        assertEquals(ConnectedState.READY, state(vm))
    }

    @Test
    fun `voice commands map to machine intents`() {
        val (vm, provider) = connectedViewModel()
        driveToReady(vm, provider)

        vm.onInput(GlassesInput.VoiceCommand("K Scan scan this"))

        assertEquals(ConnectedState.PRIVACY_PROCESSING, state(vm))
    }
}
