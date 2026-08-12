# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Expo modules, React Native/Fabric/TurboModules, Hermes/JNI, CameraX, and ML Kit
# publish consumer ProGuard rules that AGP merges into the release shrinker.
# Keep this file limited to K Scan-owned reflective/JNI entry points. Build 29
# has none on Android: Privacy Lens is Apple-only, and Sentry, Skia, TFLite,
# Nitro, ML Kit Face Detection, ML Kit Pose Detection, and CameraX XR are not in
# the release dependency graph. Blanket keeps here would silently defeat R8.

# Expo SecureStore's Kotlin module definition uses reified record conversion for
# SecureStoreOptions. R8 full-mode class merging can rewrite the generated nested
# function/coroutine classes even though expo-modules-core already keeps Record
# implementations, causing release-only argument conversion failures before auth
# can initialize. Keep this small security-critical package intact.
-keep class expo.modules.securestore.** { *; }

# The same full-mode pass can horizontally merge RecordTypeConverter with
# unrelated converters. Preserve Expo's small record-reflection bridge so the
# kept module records can still be constructed and populated at runtime.
-keep class expo.modules.kotlin.records.** { *; }
