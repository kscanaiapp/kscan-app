package com.kscan.glasses

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.kscan.glasses.navigation.InputMapper
import com.kscan.glasses.state.KScanViewModel
import com.kscan.glasses.ui.KScanGlassesApp

class MainActivity : ComponentActivity() {
    // Retained across configuration-change recreation (uiMode / fontScale /
    // density / locale changes that android:configChanges does not absorb).
    // Manual per-onCreate construction would attach a fresh set of flow
    // collectors and a second ConnectedRuntimeStateMachine to the app-scoped
    // singleton phone bridge on every recreation, duplicating outbound frames
    // (e.g. capture requests) and leaking coroutines. viewModels{} keeps one
    // instance and one collector set for the Activity's lifetime.
    private val viewModel: KScanViewModel by viewModels {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                val runtime = (application as KScanApplication).runtime
                val orchestrator = com.kscan.glasses.scan.ScanOrchestratorFactory.create(
                    config = runtime.betaConfig,
                    sanitizer = runtime.sanitizer,
                    analyzeClient = runtime.analyzeClient,
                    phoneBridge = runtime.phoneBridge,
                    clientConfig = runtime.clientConfig,
                    debugConfig = runtime.debugConfig,
                )
                return KScanViewModel(
                    bridge = runtime.bridge,
                    orchestrator = orchestrator,
                    runtimeStatus = runtime.runtimeStatus,
                    // Connected mode: the verified phone bridge drives the connected HUD;
                    // debug-disabled and release-stub providers render honest cards.
                    phoneBridge = runtime.phoneBridge,
                ) as T
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // The single authoritative runtime is constructed and verified in
        // KScanApplication; the retained [viewModel] (see field) composes the
        // orchestrator from it. Debug mock profile -> mock pipeline (labeled
        // MOCK). Debug strict-privacy -> strict sanitizer, fail-closed upload.
        // Release -> strict sanitizer + fail-closed analyze client; never mock.
        setContent {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                // 600×600 safe viewport for glasses display
                Box(modifier = Modifier.size(600.dp)) {
                    KScanGlassesApp(viewModel = viewModel)
                }
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent?): Boolean {
        InputMapper.fromKeyEvent(keyCode)?.let {
            viewModel.onInput(it)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
