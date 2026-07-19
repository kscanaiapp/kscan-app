const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
} = require('expo/config-plugins');

// Foreground services that dependency library manifests merge into the app manifest but
// that K Scan never starts. Google Play's foreground-service policy would flag these if
// they shipped in a release AAB, so we strip them with manifest-merger removal tombstones.
//
//   expo-location  .services.LocationTaskService        (foregroundServiceType="location")
//     -> app only reads a foreground position for weather styling; no task/background service.
//   expo-audio     .service.AudioControlsService        (foregroundServiceType="mediaPlayback")
//   expo-audio     .service.AudioRecordingService       (foregroundServiceType="microphone")
//     -> stylist voice plays foreground-only (setAudioModeAsync shouldPlayInBackground:false,
//        keepAudioSessionActive:false) and recording is disabled, so neither service is used.
//
// This reproduces, on Expo prebuild, the same removals the committed native
// android/app/src/main/AndroidManifest.xml already performs, so a clean prebuild cannot
// silently restore any of these services.
const UNUSED_FOREGROUND_SERVICES = [
  'expo.modules.location.services.LocationTaskService',
  'expo.modules.audio.service.AudioControlsService',
  'expo.modules.audio.service.AudioRecordingService',
];
const TOOLS_NAMESPACE = 'http://schemas.android.com/tools';

/**
 * Adds manifest-merger removal tombstones for every unused foreground service.
 * Uses Expo's real Android manifest object shape (attributes under `$`), is idempotent
 * (no duplicate entries on repeated runs / prebuilds), and preserves all unrelated content.
 */
function removeUnusedForegroundServices(androidManifest) {
  const { manifest } = androidManifest;

  manifest.$ = manifest.$ || {};
  if (manifest.$['xmlns:tools'] !== TOOLS_NAMESPACE) {
    manifest.$['xmlns:tools'] = TOOLS_NAMESPACE;
  }

  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  if (!Array.isArray(application.service)) {
    application.service = [];
  }

  for (const serviceName of UNUSED_FOREGROUND_SERVICES) {
    const existing = application.service.find(
      (service) => service && service.$ && service.$['android:name'] === serviceName,
    );
    if (existing) {
      existing.$['tools:node'] = 'remove';
    } else {
      application.service.push({
        $: { 'android:name': serviceName, 'tools:node': 'remove' },
      });
    }
  }

  return androidManifest;
}

const withRemoveUnusedForegroundServices = (config) =>
  withAndroidManifest(config, (config) => {
    config.modResults = removeUnusedForegroundServices(config.modResults);
    return config;
  });

module.exports = createRunOncePlugin(
  withRemoveUnusedForegroundServices,
  'with-remove-unused-foreground-services',
  '1.0.0',
);
// Exported for unit testing of the manifest transform.
module.exports.removeUnusedForegroundServices = removeUnusedForegroundServices;
module.exports.UNUSED_FOREGROUND_SERVICES = UNUSED_FOREGROUND_SERVICES;
