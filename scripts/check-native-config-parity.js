#!/usr/bin/env node
/**
 * Native / declarative config parity gate (B34-DEF-002).
 *
 * Expo Doctor's "app config fields that may not be synced in a non-CNG
 * project" warning is a blanket check: it fires whenever native project
 * folders coexist with prebuild-style config, and it cannot tell you whether
 * that is a real problem or a deliberate architecture. This repository is
 * deliberately mixed per platform (see config/native-config-authority.json):
 *
 *   Android: NATIVE_AUTHORITATIVE -- android/ is committed and drives the
 *            shipped artifact (Build 32 R8/AAB hardening lives there).
 *            app.json's `android` block must match it.
 *   iOS:     CNG_AUTHORITATIVE -- no ios/ is committed; app.json's `ios`
 *            block IS the artifact source, expanded fresh by Expo CNG.
 *
 * This gate enforces that split explicitly instead of leaving it as an
 * unstated fact someone has to rediscover:
 *
 *   - Android: app.json's android.package/versionCode/permissions/
 *     blockedPermissions/intentFilters must match
 *     android/app/build.gradle and android/app/src/main/AndroidManifest.xml.
 *   - iOS: every permission plugin that requires a usage-description string
 *     must have one declared in app.json's ios.infoPlist; bundleIdentifier
 *     and associatedDomains must be present.
 *   - Cross-platform: bundle/application ID must be identical, and the
 *     autoVerify https deep-link host in Android's intentFilters must equal
 *     the host inside iOS's `applinks:` associatedDomains entry.
 *
 * It does not regenerate or modify android/, ios/, or app.json. A failure
 * means the two representations disagree; the person resolving it decides
 * which side is correct.
 *
 * Usage:   node scripts/check-native-config-parity.js
 * Exit 0:  no disagreement found
 * Exit 1:  a declared setting disagrees with what the authoritative side has
 * Exit 2:  usage / operational error (a required file is missing)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Root the gate reads from. Defaults to this repository. The override exists
// so the negative-control tests can point the gate at an isolated fixture
// tree instead of mutating this repository's own app.json in place -- doing
// that made every concurrently-running test file that reads app.json
// (oauthCallback, iosAppReviewSurface, ...) fail intermittently. CI still
// invokes the gate with no override, so it still checks the real tree.
const REPO_ROOT = process.env.NATIVE_CONFIG_PARITY_ROOT
  ? path.resolve(process.env.NATIVE_CONFIG_PARITY_ROOT)
  : path.resolve(__dirname, '..');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');
const AUTHORITY_PATH = path.join(REPO_ROOT, 'config', 'native-config-authority.json');
const GRADLE_PATH = path.join(REPO_ROOT, 'android', 'app', 'build.gradle');
const MANIFEST_PATH = path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

function readIfExists(absolutePath) {
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : null;
}

function requireField(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function main() {
  if (!fs.existsSync(APP_JSON_PATH)) {
    console.error('FAIL  app.json is missing.');
    process.exit(2);
  }
  if (!fs.existsSync(AUTHORITY_PATH)) {
    console.error(`FAIL  ${path.relative(REPO_ROOT, AUTHORITY_PATH)} is missing.`);
    process.exit(2);
  }

  const appConfig = JSON.parse(fs.readFileSync(APP_JSON_PATH, 'utf8')).expo;
  const authority = JSON.parse(fs.readFileSync(AUTHORITY_PATH, 'utf8'));
  const failures = [];
  const checked = [];

  // ---- Android: app.json vs the committed, authoritative native project ----
  const gradle = readIfExists(GRADLE_PATH);
  const manifest = readIfExists(MANIFEST_PATH);
  const androidHasNativeProject = fs.existsSync(path.join(REPO_ROOT, 'android'));

  if (authority.platforms.android.model === 'NATIVE_AUTHORITATIVE' && androidHasNativeProject) {
    if (!gradle) {
      failures.push(`Android is declared NATIVE_AUTHORITATIVE but ${path.relative(REPO_ROOT, GRADLE_PATH)} is missing.`);
    } else {
      const applicationIdMatch = gradle.match(/applicationId\s+'([^']+)'/);
      const versionCodeMatch = gradle.match(/versionCode\s+(\d+)/);

      if (applicationIdMatch) {
        checked.push('android.package vs build.gradle applicationId');
        if (applicationIdMatch[1] !== appConfig.android?.package) {
          failures.push(
            `android.package "${appConfig.android?.package}" != build.gradle applicationId "${applicationIdMatch[1]}".`,
          );
        }
      }
      if (versionCodeMatch) {
        checked.push('android.versionCode vs build.gradle versionCode');
        if (Number(versionCodeMatch[1]) !== appConfig.android?.versionCode) {
          failures.push(
            `android.versionCode ${appConfig.android?.versionCode} != build.gradle versionCode ${versionCodeMatch[1]}.`,
          );
        }
      }
    }

    if (!manifest) {
      failures.push(`Android is declared NATIVE_AUTHORITATIVE but ${path.relative(REPO_ROOT, MANIFEST_PATH)} is missing.`);
    } else {
      checked.push('android.permissions vs AndroidManifest.xml uses-permission');
      for (const permission of appConfig.android?.permissions || []) {
        const re = new RegExp(`<uses-permission[^>]*android:name="${permission}"(?![^>]*tools:node="remove")[^>]*/>`);
        if (!re.test(manifest)) {
          failures.push(`Permission "${permission}" is declared in app.json but not granted (un-removed) in AndroidManifest.xml.`);
        }
      }
      checked.push('android.blockedPermissions vs AndroidManifest.xml tools:node="remove"');
      for (const permission of appConfig.android?.blockedPermissions || []) {
        const re = new RegExp(`<uses-permission[^>]*android:name="${permission}"[^>]*tools:node="remove"[^>]*/>`);
        if (!re.test(manifest)) {
          failures.push(`Permission "${permission}" is declared blocked in app.json but is not tools:node="remove" in AndroidManifest.xml.`);
        }
      }

      // Reverse direction: every permission actively GRANTED in the manifest
      // (no tools:node="remove") must be declared in app.json.android.permissions.
      // Without this, deleting a permission from app.json's declared list while
      // the manifest still grants it would silently pass.
      checked.push('AndroidManifest.xml granted permissions vs android.permissions (reverse direction)');
      const declaredPermissions = new Set(appConfig.android?.permissions || []);
      const grantedInManifest = [
        ...manifest.matchAll(/<uses-permission android:name="([^"]+)"\s*\/>/g),
      ].map((match) => match[1]);
      for (const permission of grantedInManifest) {
        if (!declaredPermissions.has(permission)) {
          failures.push(
            `Permission "${permission}" is actively granted in AndroidManifest.xml but is not declared in ` +
              'app.json android.permissions -- app.json no longer describes what the artifact actually requests.',
          );
        }
      }

      checked.push('android.intentFilters vs AndroidManifest.xml intent-filter data');
      for (const filter of appConfig.android?.intentFilters || []) {
        for (const data of filter.data || []) {
          const parts = [`android:scheme="${data.scheme}"`];
          if (data.host) parts.push(`android:host="${data.host}"`);
          if (data.pathPrefix) parts.push(`android:pathPrefix="${data.pathPrefix}"`);
          const found = parts.every((part) => manifest.includes(part));
          if (!found) {
            failures.push(
              `Intent filter data (${parts.join(', ')}) declared in app.json was not found as a single ` +
                '<data> element in AndroidManifest.xml.',
            );
          }
        }
      }
    }
  }

  // ---- iOS: internal consistency of the CNG-authoritative app.json ios block ----
  if (authority.platforms.ios.model === 'CNG_AUTHORITATIVE') {
    checked.push('ios.bundleIdentifier is declared');
    if (!appConfig.ios?.bundleIdentifier) {
      failures.push('ios.bundleIdentifier is required (iOS has no native project to fall back on).');
    }

    checked.push('ios.associatedDomains is declared');
    if (!appConfig.ios?.associatedDomains || appConfig.ios.associatedDomains.length === 0) {
      failures.push('ios.associatedDomains is required (iOS has no native project to fall back on).');
    }

    // Every permission plugin that needs a usage-description string must have
    // one under ios.infoPlist -- CNG has nothing else to fall back on.
    const permissionKeyByPlugin = {
      'expo-camera': 'NSCameraUsageDescription',
      'expo-image-picker': 'NSPhotoLibraryUsageDescription',
      'expo-location': 'NSLocationWhenInUseUsageDescription',
    };
    checked.push('permission plugins vs ios.infoPlist usage-description keys');
    for (const plugin of appConfig.plugins || []) {
      const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
      const requiredKey = permissionKeyByPlugin[pluginName];
      if (requiredKey && !appConfig.ios?.infoPlist?.[requiredKey]) {
        failures.push(`Plugin "${pluginName}" requires ios.infoPlist.${requiredKey}, which is missing or empty.`);
      }
    }
  }

  // ---- Cross-platform invariants ----
  if (authority.crossPlatformInvariants?.bundleIdMustMatch) {
    checked.push('cross-platform bundle/application ID identity');
    if (appConfig.android?.package && appConfig.ios?.bundleIdentifier && appConfig.android.package !== appConfig.ios.bundleIdentifier) {
      failures.push(
        `android.package "${appConfig.android.package}" != ios.bundleIdentifier "${appConfig.ios.bundleIdentifier}" ` +
          '-- this repository treats the two as required to match.',
      );
    }
  }

  if (authority.crossPlatformInvariants?.deepLinkHostMustMatch) {
    checked.push('cross-platform deep-link host (Android autoVerify intent-filter vs iOS applinks)');
    const autoVerifyFilter = (appConfig.android?.intentFilters || []).find((filter) => filter.autoVerify);
    const httpsHost = autoVerifyFilter?.data?.find((data) => data.scheme === 'https')?.host;
    const applinksEntry = (appConfig.ios?.associatedDomains || []).find((domain) => domain.startsWith('applinks:'));
    const applinksHost = applinksEntry ? applinksEntry.slice('applinks:'.length) : undefined;
    if (httpsHost && applinksHost && httpsHost !== applinksHost) {
      failures.push(
        `Android's autoVerify deep-link host "${httpsHost}" != iOS associatedDomains host "${applinksHost}".`,
      );
    } else if (httpsHost && !applinksHost) {
      failures.push(`Android declares an autoVerify deep link for "${httpsHost}" but iOS has no matching applinks: entry.`);
    }
  }

  console.log('NATIVE / DECLARATIVE CONFIG PARITY GATE');
  console.log(`  android authority : ${authority.platforms.android.model}`);
  console.log(`  ios authority     : ${authority.platforms.ios.model}`);
  console.log(`  checks performed  : ${checked.length}`);
  for (const item of checked) console.log(`    - ${item}`);

  if (failures.length > 0) {
    console.error('');
    console.error('FAIL  Configuration disagreement:');
    for (const failure of failures) console.error(`    ${failure}`);
    console.error('');
    console.error(`  ${failures.length} problem(s) found.`);
    process.exit(1);
  }

  console.log('');
  console.log('PASS  app.json agrees with the authoritative source for each platform.');
}

main();
