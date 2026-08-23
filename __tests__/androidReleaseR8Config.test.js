/**
 * Android release R8/deobfuscation source-configuration gate (Build 32).
 *
 * Google Play's "no deobfuscation file" warning traces to two independent
 * defects that must both be closed:
 *   1. android.enableMinifyInReleaseBuilds / android.enableShrinkResourcesInReleaseBuilds
 *      must be true, or R8 never runs and no mapping.txt is ever produced.
 *   2. eas.json's production android profile must preserve
 *      android/app/build/outputs/mapping/release/mapping.txt via
 *      buildArtifactPaths, or EAS discards the mapping after the build.
 *
 * scripts/check-android-release-r8-config.js checks both from source only —
 * it does not build an AAB and does not assert a mapping.txt exists on disk.
 * That belongs to the post-build Artifact Validation Gate.
 *
 * Pure Node (node:test); no Android build or AAB packaging is performed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'scripts', 'check-android-release-r8-config.js');
const REPO_ROOT = path.join(__dirname, '..');

function runGuard(repoRoot) {
  try {
    const stdout = execFileSync('node', [GUARD, repoRoot], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

function makeFixtureRepo({
  gradleProps = 'android.enableMinifyInReleaseBuilds=true\nandroid.enableShrinkResourcesInReleaseBuilds=true\n',
  buildGradle = "def enableMinifyInReleaseBuilds = (findProperty('android.enableMinifyInReleaseBuilds') ?: false).toBoolean()\n" +
    "def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'\n",
  easProductionAndroid = {
    buildType: 'app-bundle',
    buildArtifactPaths: ['android/app/build/outputs/mapping/release/mapping.txt'],
  },
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-r8-guard-'));
  fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'android', 'gradle.properties'), gradleProps);
  fs.writeFileSync(path.join(dir, 'android', 'app', 'build.gradle'), buildGradle);
  fs.writeFileSync(
    path.join(dir, 'eas.json'),
    JSON.stringify({ build: { production: { android: easProductionAndroid } } }, null, 2),
  );
  return dir;
}

test('guard PASSES on the real repo (post-repair Build 32 source state)', () => {
  const { code, stdout } = runGuard(REPO_ROOT);
  assert.equal(code, 0, `expected the real repo to pass:\n${stdout}`);
  assert.match(stdout, /PASS/);
});

test('guard PASSES on a fully-correct fixture repo', () => {
  const dir = makeFixtureRepo();
  try {
    const { code, stdout } = runGuard(dir);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /PASS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard FAILS when minify is disabled', () => {
  const dir = makeFixtureRepo({
    gradleProps: 'android.enableMinifyInReleaseBuilds=false\nandroid.enableShrinkResourcesInReleaseBuilds=true\n',
  });
  try {
    const { code, stdout } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(stdout, /enableMinifyInReleaseBuilds is not true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard FAILS when the minify property is simply absent (the actual pre-repair Build 32 defect)', () => {
  const dir = makeFixtureRepo({ gradleProps: '' });
  try {
    const { code, stdout } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(stdout, /enableMinifyInReleaseBuilds is not true/);
    assert.match(stdout, /enableShrinkResourcesInReleaseBuilds is not true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard FAILS when resource shrinking is disabled', () => {
  const dir = makeFixtureRepo({
    gradleProps: 'android.enableMinifyInReleaseBuilds=true\nandroid.enableShrinkResourcesInReleaseBuilds=false\n',
  });
  try {
    const { code, stdout } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(stdout, /enableShrinkResourcesInReleaseBuilds is not true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard FAILS when EAS production profile does not preserve mapping.txt', () => {
  const dir = makeFixtureRepo({ easProductionAndroid: { buildType: 'app-bundle' } });
  try {
    const { code, stdout } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(stdout, /buildArtifactPaths does not include the release mapping\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard FAILS (not silently passes) if build.gradle stops gating on the expected property names', () => {
  const dir = makeFixtureRepo({ buildGradle: 'android { }\n' });
  try {
    const { code, stdout } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(stdout, /no longer gates minifyEnabled/);
    assert.match(stdout, /no longer gates shrinkResources/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard exits 2 when gradle.properties is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-r8-guard-missing-'));
  try {
    const { code, stdout } = runGuard(dir);
    assert.equal(code, 2);
    assert.match(stdout, /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
