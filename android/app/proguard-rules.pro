# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# The same full-mode pass can horizontally merge RecordTypeConverter with
# unrelated converters. Preserve Expo's small record-reflection bridge so the
# kept module records can still be constructed and populated at runtime.
# Carried over from the Build 29 android-final authority
# (repair/build29-android-final@0f9bf95), whose divergent branch history never
# reached this line before R8 was re-enabled here.
-keep class expo.modules.kotlin.records.** { *; }

# Add any project specific keep options here:
