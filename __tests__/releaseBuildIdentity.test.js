/**
 * Release build identity — app.json version/buildNumber/versionCode.
 *
 * WHY THIS EXISTS: the committed build identity silently drifted from the
 * release the team was actually working on. Staging carried iOS
 * buildNumber "23" and Android versionCode 23 for the whole of "Build 29",
 * which made it impossible to tell from a tree which release it belonged to
 * — and directly obscured the IOS-02 triage, because the tested source lines
 * carried buildNumber "29" while the staging line did not.
 *
 * This gate does NOT try to guess the next number. It pins the identity of
 * the release currently under development so that changing it is a deliberate,
 * reviewed edit rather than an accident.
 *
 * IMPORTANT — what this file does and does not control:
 *   eas.json sets `cli.appVersionSource: "remote"`, and every build profile
 *   sets `autoIncrement: true`. Under that configuration EAS takes the build
 *   number from its own remote state, NOT from app.json, and increments it at
 *   build time. The values asserted here are therefore the repository's
 *   source of truth for local/bare builds and for release provenance — they do
 *   not by themselves determine the number App Store Connect receives. Keeping
 *   the remote value aligned is a separate, credentialed step.
 *   (See commit a7ae17a, which records the same constraint, and 89eec7a, where
 *   a locally-tracked number had already drifted from the real ASC state.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const easJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));

/** The release currently under development. Bumping this is a deliberate act. */
const BUILD_UNDER_DEVELOPMENT = 29;

/**
 * The highest build identity consumed by any prior release line in this repo:
 * Android versionCode 28 on the frozen Build 28 line (42829f5). Both stores
 * require a strictly increasing integer, so the current identity may never
 * regress to or below this.
 */
const HIGHEST_PRIOR_IDENTITY = 28;

const expo = appJson.expo ?? appJson;

test('marketing version is unchanged by a build bump', () => {
  assert.equal(expo.version, '1.0.1');
});

test('iOS buildNumber matches the release under development', () => {
  assert.equal(expo.ios.buildNumber, String(BUILD_UNDER_DEVELOPMENT));
});

test('Android versionCode matches the release under development', () => {
  assert.equal(expo.android.versionCode, BUILD_UNDER_DEVELOPMENT);
});

test('iOS and Android carry the SAME build identity', () => {
  // The two platforms drifting apart is what made "which build is this tree?"
  // unanswerable: staging read 23/23 while the tested iOS lines read 29.
  assert.equal(
    String(expo.ios.buildNumber),
    String(expo.android.versionCode),
    'iOS buildNumber and Android versionCode must name the same release',
  );
});

test('build identity never regresses below an already-consumed number', () => {
  assert.ok(
    Number(expo.ios.buildNumber) > HIGHEST_PRIOR_IDENTITY,
    `iOS buildNumber must exceed ${HIGHEST_PRIOR_IDENTITY}; both stores reject a reused or lower build`,
  );
  assert.ok(
    Number(expo.android.versionCode) > HIGHEST_PRIOR_IDENTITY,
    `Android versionCode must exceed ${HIGHEST_PRIOR_IDENTITY}; Play rejects a reused or lower versionCode`,
  );
});

test('build identity is a plain incrementing integer', () => {
  assert.match(String(expo.ios.buildNumber), /^\d+$/);
  assert.equal(Number.isInteger(expo.android.versionCode), true);
});

test('the EAS remote-version constraint is still in force and documented', () => {
  // If this ever flips to "local", app.json becomes authoritative for the
  // submitted number and the caveat in this file's header stops applying —
  // which is a release-mechanics decision that must be made deliberately.
  assert.equal(
    easJson.cli.appVersionSource,
    'remote',
    'appVersionSource changed: app.json would now govern the submitted build number',
  );
  assert.equal(easJson.build.staging.autoIncrement, true);
});
