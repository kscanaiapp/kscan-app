package com.kscan.glasses

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kscan.glasses.navigation.InputMapper
import com.kscan.glasses.state.KScanViewModel
import com.kscan.glasses.ui.KScanGlassesApp
import com.kscan.glasses.analyze.AnalyzeClientConfig
import com.kscan.glasses.analyze.AnalyzeClientFactory
import com.kscan.glasses.analyze.DebugAnalyzeConfig
import com.kscan.glasses.analyze.GlassesDebugEndpointClientFactory
import com.kscan.glasses.config.BetaConfig

class MainActivity : ComponentActivity() {
    private lateinit var viewModel: KScanViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val app = application as KScanApplication

        // Debug-only: use GlassesDebugEndpointClient when local debug config is present.
        // This path is active ONLY in debug builds with local.properties configured.
        // Release builds always use the standard factory path (MockAnalyzeClient default).
        val debugConfig = DebugAnalyzeConfig.fromBuildConfig()
        val analyzeClient = if (BuildConfig.DEBUG && debugConfig.isPresent && !debugConfig.dryRunBuildFlag) {
            GlassesDebugEndpointClientFactory.create(
                betaConfig = BetaConfig.DEFAULT.copy(
                    enableRealAnalyze = true,
                    enableRealFaceMasking = true,
                ),
                debugConfig = debugConfig,
            )
        } else {
            AnalyzeClientFactory.create(
                betaConfig = BetaConfig.DEFAULT,
                clientConfig = AnalyzeClientConfig.MOCK_ONLY,
            )
        }

        val orchestrator = com.kscan.glasses.scan.ScanOrchestratorFactory.create(
            analyzeClient = analyzeClient,
        )
        viewModel = KScanViewModel(
            bridge = app.bridgeProvider,
            orchestrator = orchestrator,
        )

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
