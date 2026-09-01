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
 *   - Android build-profile manifest exceptions: Android being
 *     NATIVE_AUTHORITATIVE means app.json cannot express a permission that
 *     exists in ONE build profile only (Build 34's Voice Scan certification
 *     microphone). Rather than weakening the parity rules above so such a
 *     permission slips through unnoticed, every exception must be DECLARED
 *     in config/native-config-authority.json's
 *     platforms.android.buildProfileManifestExceptions, and this gate then
 *     enforces the declaration: the exception manifest must be a strict
 *     superset of its base manifest, may grant nothing beyond the declared
 *     permissions, must keep every mustRemainRemovedEverywhere permission
 *     removed, must never introduce a <service>, and the permissions it
 *     grants must still be blocked in app.json + src/main -- which is what
 *     keeps the DEFAULT/production artifact unbroadened.
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

  // ---- Android build-profile manifest exceptions (governed, declared) ----
  //
  // Nothing here relaxes the checks above: the main manifest is still held to
  // app.json exactly as before. This adds a SECOND, narrower set of rules for
  // the one place app.json provably cannot describe -- a per-build-profile
  // manifest -- so that such a file cannot exist unexamined.
  const exceptionsBlock = authority.platforms.android?.buildProfileManifestExceptions;
  const declaredExceptions = exceptionsBlock?.exceptions || [];

  /**
   * Groovy comments are documentation, not wiring. android/app/build.gradle
   * explains the certification selector in prose that names the very
   * property, env var, and manifest path the checks below look for, so a
   * naive substring scan would report a selector as wired purely because it
   * is *described*. Block comments and whole-line `//` comments are removed;
   * trailing `//` is deliberately left alone so a URL inside a string
   * literal cannot truncate a real line of build logic.
   */
  function stripGroovyComments(gradleSource) {
    return gradleSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }


  /**
   * XML comments are documentation, not declarations. The exception manifest
   * documents what it must never contain (a <service>, a foreground-service
   * microphone permission), and a naive scan reads that prose as the very
   * violation it forbids. Strip comments before analysing structure.
   */
  function stripXmlComments(manifestXml) {
    return manifestXml.replace(/<!--[\s\S]*?-->/g, '');
  }

  /** Permissions a manifest actively GRANTS (i.e. carries no tools:node="remove"). */
  function grantedPermissions(manifestXml) {
    return [...manifestXml.matchAll(/<uses-permission([^>]*)\/>/g)]
      .filter((match) => !/tools:node="remove"/.test(match[1]))
      .map((match) => (match[1].match(/android:name="([^"]+)"/) || [])[1])
      .filter(Boolean);
  }

  /** Permissions a manifest explicitly REMOVES. */
  function removedPermissions(manifestXml) {
    return [...manifestXml.matchAll(/<uses-permission([^>]*)\/>/g)]
      .filter((match) => /tools:node="remove"/.test(match[1]))
      .map((match) => (match[1].match(/android:name="([^"]+)"/) || [])[1])
      .filter(Boolean);
  }

  // An exception manifest that exists but is NOT declared is the dangerous
  // case: it would ship permissions no gate ever looked at.
  const sourceSetsDir = path.join(REPO_ROOT, 'android', 'app', 'src');
  const declaredExceptionPaths = new Set(
    declaredExceptions
      .filter((exception) => exception.exceptionManifest)
      .map((exception) => path.resolve(REPO_ROOT, exception.exceptionManifest)),
  );
  const KNOWN_SOURCE_SETS = ['main', 'debug', 'debugOptimized', 'release'];
  if (fs.existsSync(sourceSetsDir)) {
    checked.push('undeclared build-profile manifests under android/app/src');
    for (const entry of fs.readdirSync(sourceSetsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || KNOWN_SOURCE_SETS.includes(entry.name)) continue;
      const candidate = path.join(sourceSetsDir, entry.name, 'AndroidManifest.xml');
      if (fs.existsSync(candidate) && !declaredExceptionPaths.has(path.resolve(candidate))) {
        failures.push(
          `android/app/src/${entry.name}/AndroidManifest.xml is a build-profile manifest that is NOT declared in ` +
            'config/native-config-authority.json buildProfileManifestExceptions -- an undeclared profile manifest ' +
            'ships permissions no gate inspects.',
        );
      }
    }
  }

  for (const exception of declaredExceptions) {
    const label = exception.id || '(unnamed exception)';
    checked.push(`build-profile manifest exception "${label}"`);

    const baseRaw = exception.baseManifest ? readIfExists(path.join(REPO_ROOT, exception.baseManifest)) : null;
    const exceptionRaw = exception.exceptionManifest
      ? readIfExists(path.join(REPO_ROOT, exception.exceptionManifest))
      : null;
    const baseXml = baseRaw === null ? null : stripXmlComments(baseRaw);
    const exceptionXml = exceptionRaw === null ? null : stripXmlComments(exceptionRaw);
    if (!baseXml || !exceptionXml) {
      failures.push(
        `Exception "${label}" declares baseManifest "${exception.baseManifest}" and exceptionManifest ` +
          `"${exception.exceptionManifest}", but at least one of them does not exist.`,
      );
      continue;
    }

    const exceptionGranted = grantedPermissions(exceptionXml);
    const exceptionRemoved = new Set(removedPermissions(exceptionXml));
    const baseGranted = new Set(grantedPermissions(baseXml));

    // (a) Strict superset. Selecting this manifest REPLACES the base file
    //     wholesale, so anything the base declared and this one omits is
    //     silently lost from the certification artifact.
    for (const permission of removedPermissions(baseXml)) {
      if (!exceptionRemoved.has(permission)) {
        failures.push(
          `Exception "${label}" drops "${permission}", which ${exception.baseManifest} removes. The exception ` +
            'manifest replaces the base manifest wholesale and must be a strict superset of it.',
        );
      }
    }
    for (const permission of baseGranted) {
      if (!exceptionGranted.includes(permission)) {
        failures.push(
          `Exception "${label}" drops the granted permission "${permission}" declared by ${exception.baseManifest}.`,
        );
      }
    }

    // (b) It may grant NOTHING beyond what the authority declares.
    const allowedExtra = new Set(exception.additionalGrantedPermissions || []);
    for (const permission of exceptionGranted) {
      if (baseGranted.has(permission) || allowedExtra.has(permission)) continue;
      failures.push(
        `Exception "${label}" grants "${permission}", which is neither in the base manifest nor declared in ` +
          'additionalGrantedPermissions -- every profile-specific grant must be declared before it can ship.',
      );
    }

    // (c) Permissions that must stay removed in EVERY profile.
    for (const permission of exception.mustRemainRemovedEverywhere || []) {
      if (!exceptionRemoved.has(permission)) {
        failures.push(
          `Exception "${label}" must keep "${permission}" at tools:node="remove" -- it is declared as ` +
            'mustRemainRemovedEverywhere (background / foreground-service audio capture is never approved).',
        );
      }
    }

    // (d) A profile manifest may not introduce a service. A microphone
    //     foreground service is precisely what this forbids.
    if (/<service[\s>]/.test(exceptionXml)) {
      failures.push(
        `Exception "${label}" declares a <service> element; a build-profile manifest may not introduce services.`,
      );
    }

    // (e) THE PRODUCTION NEGATIVE CONTROL. Everything the exception adds must
    //     STILL be blocked in app.json and removed in src/main. That is what
    //     proves the default/production artifact was not broadened.
    const blockedInAppJson = new Set(appConfig.android?.blockedPermissions || []);
    const declaredInAppJson = new Set(appConfig.android?.permissions || []);
    for (const permission of allowedExtra) {
      if (declaredInAppJson.has(permission)) {
        failures.push(
          `Exception "${label}" grants "${permission}", but app.json android.permissions ALSO declares it -- that ` +
            'broadens the default/production artifact, which is exactly what the exception mechanism exists to avoid.',
        );
      }
      if (!blockedInAppJson.has(permission)) {
        failures.push(
          `Exception "${label}" grants "${permission}", so app.json android.blockedPermissions must still list it ` +
            '(the default artifact must keep requesting no such permission).',
        );
      }
      if (manifest && !removedPermissions(stripXmlComments(manifest)).includes(permission)) {
        failures.push(
          `Exception "${label}" grants "${permission}", so android/app/src/main/AndroidManifest.xml must still ` +
            'carry it at tools:node="remove".',
        );
      }
    }

    // (f) The selector must actually be read by the native build, and must be
    //     set by exactly the EAS profiles the authority declares.
    const gradleWiring = gradle ? stripGroovyComments(gradle) : null;
    if (gradleWiring) {
      if (exception.selectorGradleProperty && !gradleWiring.includes(exception.selectorGradleProperty)) {
        failures.push(
          `Exception "${label}" declares Gradle selector "${exception.selectorGradleProperty}", which ` +
            'android/app/build.gradle never reads.',
        );
      }
      if (exception.selectorEnvironmentVariable && !gradleWiring.includes(exception.selectorEnvironmentVariable)) {
        failures.push(
          `Exception "${label}" declares env selector "${exception.selectorEnvironmentVariable}", which ` +
            'android/app/build.gradle never reads.',
        );
      }
      if (exception.exceptionManifest) {
        const manifestBasename = exception.exceptionManifest.split('/').slice(-2).join('/');
        if (!gradleWiring.includes(manifestBasename)) {
          failures.push(
            `Exception "${label}" declares exceptionManifest "${exception.exceptionManifest}", but ` +
              'android/app/build.gradle never selects it -- a manifest nothing points at cannot take effect.',
          );
        }
      }
    }

    const easRaw = readIfExists(path.join(REPO_ROOT, 'eas.json'));
    if (easRaw && exception.selectorEnvironmentVariable) {
      const eas = JSON.parse(easRaw);
      const expectedProfiles = new Set(exception.selectorSetByEasProfiles || []);
      for (const [profileName, profile] of Object.entries(eas.build || {})) {
        const setsSelector = Boolean(profile.env && exception.selectorEnvironmentVariable in profile.env);
        if (setsSelector && !expectedProfiles.has(profileName)) {
          failures.push(
            `EAS profile "${profileName}" sets "${exception.selectorEnvironmentVariable}", but exception "${label}" ` +
              `declares it for [${[...expectedProfiles].join(', ')}] only.`,
          );
        }
        if (!setsSelector && expectedProfiles.has(profileName)) {
          failures.push(
            `Exception "${label}" declares EAS profile "${profileName}" as a selector site, but that profile does ` +
              `not set "${exception.selectorEnvironmentVariable}".`,
          );
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
