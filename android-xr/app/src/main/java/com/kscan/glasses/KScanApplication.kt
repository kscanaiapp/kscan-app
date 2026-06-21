package com.kscan.glasses

import android.app.Application
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.GoogleBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.safety.ReleaseSafetyGuard

class KScanApplication : Application() {
    lateinit var bridgeProvider: GlassesBridgeProvider
        private set

    override fun onCreate() {
        super.onCreate()

        // Fail fast in release builds if mock infrastructure is accidentally enabled.
        ReleaseSafetyGuard.verify()

        bridgeProvider = if (BuildConfig.USE_MOCK_BRIDGE) {
            MockBridgeProvider()
        } else {
            GoogleBridgeProvider()
        }
    }
}
