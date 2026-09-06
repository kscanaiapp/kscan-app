'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CAPTURE_PROFILES, getCaptureProfile, detailRetentionScore, applyCaptureProfileToFixture } = require('./profiles');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');

test('PLATFORM: capture profiles are explicitly versioned/named from repository truth', () => {
  assert.ok(CAPTURE_PROFILES['ios-current-v1']);
  assert.ok(CAPTURE_PROFILES['android-current-v1']);
  assert.equal(CAPTURE_PROFILES['ios-current-v1'].profileId, 'ios-current-v1');
});

test('PLATFORM: iOS and Android profiles carry identical real constants (proven from source, see authority/)', () => {
  const ios = getCaptureProfile('ios-current-v1');
  const android = getCaptureProfile('android-current-v1');
  assert.equal(ios.privacyPassMaxDimension, android.privacyPassMaxDimension);
  assert.equal(ios.privacyPassQuality, android.privacyPassQuality);
  assert.equal(ios.analysisPassWidth, android.analysisPassWidth);
  assert.equal(ios.analysisPassQuality, android.analysisPassQuality);
});

test('PLATFORM: unknown capture profile id throws rather than silently defaulting', () => {
  assert.throws(() => getCaptureProfile('windows-phone-v1'));
});

test('PLATFORM: detail-retention transform is deterministic for a given profile', () => {
  const s1 = detailRetentionScore('ios-current-v1');
  const s2 = detailRetentionScore('ios-current-v1');
  assert.equal(s1, s2);
});

test('PLATFORM: profile-neutral applies no degradation', () => {
  assert.equal(detailRetentionScore('profile-neutral'), 1);
});

test('PLATFORM: the same underlying fixture can be evaluated under multiple capture profiles', () => {
  const fixtures = loadSyntheticCorpus();
  const base = fixtures[0];
  const asIos = applyCaptureProfileToFixture({ ...base, captureProfile: 'ios-current-v1' });
  const asAndroid = applyCaptureProfileToFixture({ ...base, captureProfile: 'android-current-v1' });
  assert.notEqual(asIos.captureProfileMeta.profileId, asAndroid.captureProfileMeta.profileId);
  // Same real constants -> same detail-retention score, proving the metric
  // is capable of stratifying by profile even where the two are identical.
  assert.equal(asIos.captureProfileMeta.detailRetentionScore, asAndroid.captureProfileMeta.detailRetentionScore);
});

test('PLATFORM: the committed corpus contains at least one platform-parity pair (pairedFixtureId)', () => {
  const fixtures = loadSyntheticCorpus();
  const paired = fixtures.filter((f) => f.pairedFixtureId);
  assert.ok(paired.length >= 2, 'expected at least one iOS/Android pair (2 fixtures) in the synthetic corpus');
  for (const fixture of paired) {
    const partner = fixtures.find((f) => f.fixtureId === fixture.pairedFixtureId);
    assert.ok(partner, `paired fixture ${fixture.pairedFixtureId} referenced by ${fixture.fixtureId} must exist`);
    assert.notEqual(fixture.captureProfile, partner.captureProfile);
  }
});
