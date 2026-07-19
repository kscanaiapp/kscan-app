package com.kscan.glasses

import android.app.Application
import com.kscan.glasses.analyze.DebugAnalyzeConfig
import com.kscan.glasses.analyze.DebugAnalyzeCredentialProvider
import com.kscan.glasses.runtime.AppRuntimeFactory
import com.kscan.glasses.safety.ReleaseSafetyGuard

class KScanApplication : Application() {

    /**
     * The single authoritative set of runtime dependencies, constructed and
     * cross-verified once at startup by [AppRuntimeFactory].
     */
    lateinit var runtime: AppRuntimeFactory.Resolved
        private set

    override fun onCreate() {
        super.onCreate()

        // Fail fast in release builds if mock infrastructure is accidentally enabled.
        ReleaseSafetyGuard.verify()

        // BuildConfig supplies non-secret debug URL/flags only. Auth tokens come
        // exclusively from the runtime credential provider (never BuildConfig).
        val debugConfig = DebugAnalyzeCredentialProvider.mergeInto(
            config = DebugAnalyzeConfig.fromBuildConfig(),
            runtimeToken = DebugAnalyzeCredentialProvider.read(this),
        )

        // Construct bridge, sanitizer, and analyze client from one profile and
        // verify that the resolved instances agree with the build configuration.
        runtime = AppRuntimeFactory.resolve(debugConfig = debugConfig)
    }
}
