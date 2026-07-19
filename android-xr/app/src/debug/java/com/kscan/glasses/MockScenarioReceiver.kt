package com.kscan.glasses

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.kscan.glasses.phonebridge.mock.MockCompanionScenarios
import com.kscan.glasses.phonebridge.mock.MockPhoneBridgeProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * DEBUG-ONLY scenario trigger for emulator validation of the connected HUD.
 *
 * Compiled solely into debug builds (src/debug). Double-gated at runtime:
 * no-op unless BuildConfig.KSCAN_DEBUG_MOCK_PHONE_BRIDGE is true AND the
 * active phone bridge is the in-memory mock. Driven from adb:
 *
 *   am broadcast -a com.kscan.glasses.action.MOCK_SCENARIO \
 *       -n com.kscan.glasses/.MockScenarioReceiver -e scenario <name>
 *
 * Declared non-exported; reachable from the shell only on rooted/debuggable
 * images (emulator). Never present in release builds.
 */
class MockScenarioReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        if (!BuildConfig.KSCAN_DEBUG_MOCK_PHONE_BRIDGE) return
        val scenario = intent.getStringExtra(EXTRA_SCENARIO) ?: return
        val app = context.applicationContext as? KScanApplication ?: return
        val provider = app.runtime.phoneBridge as? MockPhoneBridgeProvider ?: return
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                MockCompanionScenarios.apply(provider.companion, scenario)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION = "com.kscan.glasses.action.MOCK_SCENARIO"
        const val EXTRA_SCENARIO = "scenario"
    }
}
