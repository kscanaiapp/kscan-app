#!/usr/bin/env node
/**
 * Android release R8/deobfuscation source-configuration guard (Build 32).
 *
 * Google Play's "no deobfuscation file" warning has two independent root
 * causes: (1) R8 never ran, so no mapping.txt exists, or (2) R8 ran but the
 * mapping was never preserved/uploaded. This guard checks ONLY the source
 * configuration side (1) — that the production release build is actually
 * wired to run R8 with resource shrinking, and that the EAS production
 * profile is wired to preserve the resulting mapping.txt as a build artifact.
 * It does NOT build an AAB and does NOT verify an actual mapping.txt exists
 * on disk — that belongs to the post-build Artifact Validation Gate, which
 * must inspect the real build output for an exact SOURCE SHA -> AAB ->
 * versionCode -> mapping.txt association.
 *
 * Usage:
 *   node scripts/check-android-release-r8-config.js [repoRoot]
 *
 * Exit codes:
 *   0  source configuration correct
 *   1  R8/shrink disabled, or EAS production profile does not preserve mapping.txt
 *   2  expected file not found / usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');

function readFileOrExit(absPath, label) {
  if (!fs.existsSync(absPath)) {
    console.error(`[android-r8-guard] ERROR: ${label} not found: ${absPath}`);
    process.exit(2);
  }
  return fs.readFileSync(absPath, 'utf8');
}

function propertyBoolean(propertiesText, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, 'm');
  const match = propertiesText.match(re);
  return match ? match[1].trim().toLowerCase() === 'true' : false;
}

function analyze(repoRoot) {
  const gradlePropsPath = path.join(repoRoot, 'android', 'gradle.properties');
  const buildGradlePath = path.join(repoRoot, 'android', 'app', 'build.gradle');
  const easJsonPath = path.join(repoRoot, 'eas.json');

  const gradleProps = readFileOrExit(gradlePropsPath, 'android/gradle.properties');
  const buildGradle = readFileOrExit(buildGradlePath, 'android/app/build.gradle');
  const easJson = JSON.parse(readFileOrExit(easJsonPath, 'eas.json'));

  const failures = [];

  // The release buildType must be gated on these exact property names — if the
  // gate name in build.gradle ever drifts, this check must be updated too.
  if (!buildGradle.includes("findProperty('android.enableMinifyInReleaseBuilds')")) {
    failures.push('android/app/build.gradle no longer gates minifyEnabled on android.enableMinifyInReleaseBuilds — update this guard.');
  }
  if (!buildGradle.includes("findProperty('android.enableShrinkResourcesInReleaseBuilds')")) {
    failures.push('android/app/build.gradle no longer gates shrinkResources on android.enableShrinkResourcesInReleaseBuilds — update this guard.');
  }

  if (!propertyBoolean(gradleProps, 'android.enableMinifyInReleaseBuilds')) {
    failures.push('android.enableMinifyInReleaseBuilds is not true in android/gradle.properties — R8 will not run on the release build, so no mapping.txt will be produced.');
  }
  if (!propertyBoolean(gradleProps, 'android.enableShrinkResourcesInReleaseBuilds')) {
    failures.push('android.enableShrinkResourcesInReleaseBuilds is not true in android/gradle.properties — resource shrinking will not run on the release build.');
  }

  const productionAndroid = easJson?.build?.production?.android || {};
  const artifactPaths = productionAndroid.buildArtifactPaths || [];
  const preservesMapping = artifactPaths.some((p) => p.includes('mapping.txt'));
  if (!preservesMapping) {
    failures.push('eas.json build.production.android.buildArtifactPaths does not include the release mapping.txt path — EAS will discard the R8 mapping after the build.');
  }

  return { failures, gradlePropsPath, easJsonPath };
}

function main() {
  const repoRoot = path.resolve(process.argv[2] || process.cwd());
  const { failures, gradlePropsPath, easJsonPath } = analyze(repoRoot);

  console.log(`[android-r8-guard] Inspected:\n  ${gradlePropsPath}\n  ${easJsonPath}`);

  if (failures.length > 0) {
    console.error('\n[android-r8-guard] FAIL — Android release R8/deobfuscation source configuration is incomplete:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      '\n  This is a SOURCE CONFIGURATION check only. It does not prove a mapping.txt\n' +
        '  was actually produced for a given build — that requires the post-build\n' +
        '  Artifact Validation Gate against the real EAS build output.',
    );
    process.exit(1);
  }

  console.log('\n[android-r8-guard] PASS — R8 + resource shrinking enabled for release, and EAS production profile preserves mapping.txt.');
  process.exit(0);
}

main();
