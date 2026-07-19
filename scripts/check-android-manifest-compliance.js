#!/usr/bin/env node
/**
 * Focused Android release-manifest compliance guard (v24).
 *
 * K Scan ships with NO Android foreground service. Dependency library manifests
 * (expo-location, expo-audio) merge in foreground services that K Scan never starts:
 *   - expo.modules.location.services.LocationTaskService   (location)
 *   - expo.modules.audio.service.AudioControlsService      (mediaPlayback)
 *   - expo.modules.audio.service.AudioRecordingService     (microphone)
 * These, and every permission outside K Scan's approved release posture, must not appear
 * in the merged release manifest. This guard inspects an already-merged release manifest
 * (Gradle / EAS output, e.g. `:app:processReleaseManifest`). It does NOT build or package
 * an AAB.
 *
 * Usage:
 *   node scripts/check-android-manifest-compliance.js [path-to-AndroidManifest.xml]
 *   KSCAN_MERGED_MANIFEST=/abs/path node scripts/check-android-manifest-compliance.js
 *
 * Exit codes:
 *   0  compliant
 *   1  prohibited entry found (do NOT build an AAB)
 *   2  manifest not found / usage error
 *
 * Scope note: intentionally approval-focused — this is not a general Android manifest auditor.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Hard-fail services (unused foreground services that must be tombstoned out).
const PROHIBITED_SERVICES = [
  'expo.modules.location.services.LocationTaskService',
  'expo.modules.audio.service.AudioControlsService',
  'expo.modules.audio.service.AudioRecordingService',
];
const REQUIRED_PERMISSIONS = [
  'android.permission.CAMERA',
  'android.permission.INTERNET',
  'android.permission.VIBRATE',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.MODIFY_AUDIO_SETTINGS',
];

// Hard-fail dangerous or release-unapproved permissions. Normal, non-dangerous
// dependency permissions (for example ACCESS_NETWORK_STATE) are intentionally not
// rejected by this focused Play-approval guard.
const PROHIBITED_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
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

const DEFAULT_CANDIDATES = [
  'android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifest/release/AndroidManifest.xml',
];

function resolveManifestPath() {
  const cliArg = process.argv[2];
  if (cliArg) return path.resolve(cliArg);
  if (process.env.KSCAN_MERGED_MANIFEST) return path.resolve(process.env.KSCAN_MERGED_MANIFEST);
  for (const rel of DEFAULT_CANDIDATES) {
    const abs = path.resolve(process.cwd(), rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function extractPermissions(xml) {
  const names = new Set();
  const re = /<uses-permission[^>]*android:name="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) names.add(m[1]);
  return names;
}

function extractServices(xml) {
  const services = [];
  const re = /<service\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const name = (tag.match(/android:name="([^"]+)"/) || [])[1] || '(unnamed)';
    const node = (tag.match(/tools:node="([^"]+)"/) || [])[1] || null;
    const fgsType = (tag.match(/android:foregroundServiceType="([^"]+)"/) || [])[1] || null;
    services.push({ name, node, fgsType });
  }
  return services;
}

function extractForegroundServiceTypes(xml) {
  const types = [];
  const re = /android:foregroundServiceType="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) types.push(m[1]);
  return types;
}

function analyze(xml) {
  const perms = extractPermissions(xml);
  const services = extractServices(xml);
  const fgsTypes = extractForegroundServiceTypes(xml);

  const failures = [];
  const warnings = [];

  for (const s of services) {
    if (s.node === 'remove') {
      failures.push({
        entry: `<service android:name="${s.name}" tools:node="remove">`,
        why: 'A removal tombstone was packaged in the merged manifest instead of being consumed by the manifest merger.',
      });
      continue;
    }
    if (PROHIBITED_SERVICES.includes(s.name)) {
      failures.push({
        entry: `<service android:name="${s.name}">`,
        why: 'Unused foreground service (dependency-declared); Google Play prohibits shipping an undeclared/unused foreground service.',
      });
    }
    if (s.fgsType) {
      failures.push({
        entry: `<service android:name="${s.name}" android:foregroundServiceType="${s.fgsType}">`,
        why: `foregroundServiceType="${s.fgsType}" is incompatible with K Scan's zero-FGS release posture.`,
      });
    }
  }

  for (const p of REQUIRED_PERMISSIONS) {
    if (!perms.has(p)) {
      failures.push({
        entry: `<uses-permission android:name="${p}"> (missing)`,
        why: 'Required release permission is absent; this can break an approved foreground feature.',
      });
    }
  }

  for (const p of PROHIBITED_PERMISSIONS) {
    if (perms.has(p)) {
      failures.push({
        entry: `<uses-permission android:name="${p}">`,
        why: 'Release-unapproved permission incompatible with K Scan\'s current Play disclosure and runtime posture.',
      });
    }
  }

  // Never silently ignore a new FOREGROUND_SERVICE_* permission.
  for (const p of perms) {
    if (/^android\.permission\.FOREGROUND_SERVICE/.test(p) && !PROHIBITED_PERMISSIONS.includes(p)) {
      failures.push({
        entry: `<uses-permission android:name="${p}">`,
        why: 'Any foreground-service permission is incompatible with K Scan\'s zero-FGS release posture.',
      });
    }
  }

  return { perms, services, fgsTypes, failures, warnings };
}

function main() {
  const manifestPath = resolveManifestPath();
  if (!manifestPath) {
    console.error(
      '[android-manifest-guard] ERROR: no merged release manifest found.\n' +
        '  Generate one first (no packaging), then pass its path, e.g.:\n' +
        '    (cd android && ./gradlew :app:processReleaseManifest)\n' +
        '    node scripts/check-android-manifest-compliance.js \\\n' +
        '      android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml\n' +
        '  A merged release manifest MUST be inspected before building an AAB.',
    );
    process.exit(2);
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`[android-manifest-guard] ERROR: manifest not found: ${manifestPath}`);
    process.exit(2);
  }

  const xml = fs.readFileSync(manifestPath, 'utf8');
  const { services, fgsTypes, failures, warnings } = analyze(xml);

  console.log(`[android-manifest-guard] Inspected merged release manifest:\n  ${manifestPath}`);
  console.log(
    `[android-manifest-guard] Services: ${services.length} | foregroundServiceType occurrences: ${fgsTypes.length}`,
  );
  for (const s of services) {
    const tag = s.node === 'remove' ? ' (tools:node=remove)' : '';
    const fgs = s.fgsType ? ` [foregroundServiceType=${s.fgsType}]` : '';
    console.log(`    - service: ${s.name}${fgs}${tag}`);
  }

  for (const w of warnings) console.warn(`[android-manifest-guard] WARN: ${w}`);

  if (failures.length > 0) {
    console.error('\n[android-manifest-guard] FAIL — prohibited entries in merged release manifest:');
    for (const f of failures) {
      console.error(`  ✗ ${f.entry}`);
      console.error(`      why: ${f.why}`);
    }
    console.error(`  inspected manifest: ${manifestPath}`);
    console.error(
      '\n  These entries block Google Play compliance for K Scan.\n' +
        '  DO NOT build or upload an AAB until the merged release manifest is clean.',
    );
    process.exit(1);
  }

  console.log('\n[android-manifest-guard] PASS — no prohibited foreground-service or background-location entries.');
  if (warnings.length > 0) {
    console.log('[android-manifest-guard] NOTE: review the WARN item(s) above before release (advisory).');
  }
  process.exit(0);
}

main();
