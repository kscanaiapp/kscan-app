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

class MainActivity : ComponentActivity() {
    private lateinit var viewModel: KScanViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val app = application as KScanApplication
        viewModel = KScanViewModel(
            bridge = app.bridgeProvider,
            useMockApi = BuildConfig.USE_MOCK_API,
            useMockSanitizer = BuildConfig.USE_MOCK_SANITIZER,
            backendUrl = BuildConfig.KSCAN_BACKEND_URL,
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
