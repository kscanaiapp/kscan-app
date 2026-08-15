'use strict';

/**
 * The single source of truth for K Scan's Android native declaration surface.
 *
 * Build 28 shipped to Google Play with a deliberately minimal Android manifest.
 * Build 29 regenerated `android/` from Expo prebuild and silently lost every
 * removal, because the removals lived only in hand-edited generated output and
 * in two config plugins that did not survive the promotion. This module is the
 * authoritative list; `app.json`, the checked-in manifests, and the regression
 * suite all bind to it, so a future prebuild cannot quietly restore anything.
 *
 * Deliberately dependency-free (no `expo/config-plugins`) so the contract can be
 * asserted without an installed native toolchain.
 */

/** Permissions K Scan actually requests at runtime. */
const GRANTED_PERMISSIONS = [
  'android.permission.CAMERA',
  'android.permission.INTERNET',
  'android.permission.VIBRATE',
  'android.permission.ACCESS_COARSE_LOCATION',
];

/**
 * Permissions that dependency manifests merge in but that Build 29 must not
 * declare. Every entry is reachable from the resolved Android graph, which is
 * dependency-identical to the certified Build 28 graph apart from
 * `@sentry/react-native` and `expo-secure-store` (neither adds a permission).
 */
const BLOCKED_PERMISSIONS = [
  // expo-camera / expo-audio capture surfaces K Scan does not use.
  'android.permission.RECORD_AUDIO',
  // expo-location: styling uses coarse, foreground-only position.
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  // Foreground-service permissions. K Scan starts NO foreground service; the
  // expo-location and expo-audio services below are stripped. Declaring any of
  // these would put the release AAB under Google Play's foreground-service
  // policy for a capability the app never exercises.
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  // Build 29 ships no notification surface.
  'android.permission.POST_NOTIFICATIONS',
  // Media/storage: expo-image-picker uses the system photo picker, which needs
  // no storage or media permission on any supported API level.
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  // Play Services (pulled in by ML Kit barcode scanning) merges AD_ID. K Scan
  // runs no ads and declares no advertising ID in Play Data Safety.
  'com.google.android.gms.permission.AD_ID',
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.SEND_SMS',
  'android.permission.READ_CALL_LOG',
  'android.permission.WRITE_CALL_LOG',
  'android.permission.PROCESS_OUTGOING_CALLS',
  'android.permission.CALL_PHONE',
];

/**
 * Foreground services that dependency library manifests merge into the app
 * manifest but that K Scan never starts.
 *
 *   expo-location  LocationTaskService   (foregroundServiceType="location")
 *     -> weather styling reads a single foreground position; no background task.
 *   expo-audio     AudioControlsService  (foregroundServiceType="mediaPlayback")
 *   expo-audio     AudioRecordingService (foregroundServiceType="microphone")
 *     -> stylist voice plays foreground-only (shouldPlayInBackground:false) and
 *        recording is disabled app-wide, so neither service is ever started.
 */
const REMOVED_FOREGROUND_SERVICES = [
  'expo.modules.location.services.LocationTaskService',
  'expo.modules.audio.service.AudioControlsService',
  'expo.modules.audio.service.AudioRecordingService',
];

/** Permissions the release variant re-blocks as defence in depth. */
const RELEASE_ONLY_BLOCKED_PERMISSIONS = ['android.permission.SYSTEM_ALERT_WINDOW'];

const TOOLS_NAMESPACE = 'http://schemas.android.com/tools';

/**
 * Adds manifest-merger removal tombstones for every unused foreground service.
 * Operates on Expo's Android manifest object shape (attributes under `$`) and is
 * idempotent, so repeated prebuilds cannot accumulate duplicates.
 */
function removeUnusedForegroundServices(androidManifest) {
  const manifest = androidManifest && androidManifest.manifest;
  if (!manifest) {
    throw new Error('removeUnusedForegroundServices: expected an Android manifest object');
  }

  manifest.$ = manifest.$ || {};
  if (manifest.$['xmlns:tools'] !== TOOLS_NAMESPACE) {
    manifest.$['xmlns:tools'] = TOOLS_NAMESPACE;
  }

  const application = Array.isArray(manifest.application) ? manifest.application[0] : null;
  if (!application) {
    throw new Error('removeUnusedForegroundServices: manifest has no <application>');
  }
  if (!Array.isArray(application.service)) {
    application.service = [];
  }

  for (const serviceName of REMOVED_FOREGROUND_SERVICES) {
    const existing = application.service.find(
      (service) => service && service.$ && service.$['android:name'] === serviceName,
    );
    if (existing) {
      existing.$['tools:node'] = 'remove';
    } else {
      application.service.push({ $: { 'android:name': serviceName, 'tools:node': 'remove' } });
    }
  }

  return androidManifest;
}

module.exports = {
  GRANTED_PERMISSIONS,
  BLOCKED_PERMISSIONS,
  REMOVED_FOREGROUND_SERVICES,
  RELEASE_ONLY_BLOCKED_PERMISSIONS,
  TOOLS_NAMESPACE,
  removeUnusedForegroundServices,
};
