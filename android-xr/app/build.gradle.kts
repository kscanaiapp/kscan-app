import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Debug-only backend analyze helpers. Missing properties fall back to safe blank/false defaults.
fun debugProperty(name: String): String {
    return project.findProperty(name)?.toString()
        ?: localProperty(name)
        ?: ""
}

fun debugPropertyBoolean(name: String): Boolean {
    return project.findProperty(name)?.toString()?.toBoolean()
        ?: localProperty(name)?.toBoolean()
        ?: false
}

// Three-state variant: absent property falls back to the supplied default instead of false.
fun debugPropertyBooleanOrDefault(name: String, defaultValue: Boolean): Boolean {
    val raw = project.findProperty(name)?.toString() ?: localProperty(name)
    return raw?.toBoolean() ?: defaultValue
}

fun localProperty(name: String): String? {
    val file = rootProject.file("local.properties")
    return if (file.exists()) {
        Properties().apply { load(file.inputStream()) }.getProperty(name)
    } else null
}

android {
    namespace = "com.kscan.glasses"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.kscan.glasses"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-alpha"

        // Debug-only backend analyze config. Committed defaults are blank/disabled.
        // Real values must be supplied via gitignored local.properties (or project properties)
        // and are never committed.
        //
        // SECURITY: Never place credentials, tokens, or secrets in BuildConfig.
        // BuildConfig values are compiled into the APK and can be extracted.
        // Debug URLs must not contain embedded credentials (e.g. no user:pass in the URL).
        val debugAnalyzeEnabled = debugPropertyBoolean("KSCAN_DEBUG_ANALYZE_ENABLED")
        val debugAnalyzeUrl = debugProperty("KSCAN_DEBUG_ANALYZE_URL")
        val debugAnalyzeDryRun = debugPropertyBoolean("KSCAN_DEBUG_ANALYZE_DRY_RUN")
        buildConfigField("boolean", "KSCAN_DEBUG_ANALYZE_ENABLED", "$debugAnalyzeEnabled")
        buildConfigField("String", "KSCAN_DEBUG_ANALYZE_URL", "\"$debugAnalyzeUrl\"")
        buildConfigField("boolean", "KSCAN_DEBUG_ANALYZE_DRY_RUN", "$debugAnalyzeDryRun")

        // Debug defaults: mock infrastructure is allowed for local development without hardware.
        buildConfigField("boolean", "USE_MOCK_BRIDGE", "true")
        buildConfigField("boolean", "USE_MOCK_API", "true")
        buildConfigField("boolean", "USE_MOCK_SANITIZER", "true")

        vectorDrawables {
            useSupportLibrary = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Release builds must never use mock API, mock sanitizer, or mock bridge.
            // ReleaseSafetyGuard.verify() throws at startup if any of these is ever true.
            buildConfigField("boolean", "USE_MOCK_API", "false")
            buildConfigField("boolean", "USE_MOCK_BRIDGE", "false")
            buildConfigField("boolean", "USE_MOCK_SANITIZER", "false")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            // Debug builds may use mock bridge and mock sanitizer for emulator/local testing.
            buildConfigField("boolean", "USE_MOCK_BRIDGE", "true")
            buildConfigField("boolean", "USE_MOCK_API", "true")
            // Debug strict-privacy profile: set KSCAN_DEBUG_USE_MOCK_SANITIZER=false in
            // gitignored local.properties to select the strict sanitizer in debug builds.
            // Upload then fails closed while face masking is unavailable in this build.
            buildConfigField("boolean", "USE_MOCK_SANITIZER", "${debugPropertyBooleanOrDefault("KSCAN_DEBUG_USE_MOCK_SANITIZER", true)}")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.3")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
    testImplementation("io.mockk:mockk:1.13.11")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
