package com.kscan.glasses

import android.app.Application
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.GoogleBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider

class KScanApplication : Application() {
    lateinit var bridgeProvider: GlassesBridgeProvider
        private set

    override fun onCreate() {
        super.onCreate()
        bridgeProvider = if (BuildConfig.USE_MOCK_BRIDGE) {
            MockBridgeProvider(applicationContext)
        } else {
            GoogleBridgeProvider(applicationContext)
        }
    }
}
