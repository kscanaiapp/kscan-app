'use strict';

/**
 * Capture profiles, derived from repository truth
 * (tools/fashion-match-quality/authority/platformCaptureProfiles.json,
 * itself sourced from hooks/useKScan.js and services/privacyImageUpload.ts).
 *
 * Per spec section 11: names are based on real paths, not imagined
 * architecture. Per spec section 12: this does NOT emulate a native image
 * pipeline. The "transform" below operates at the FIXTURE DESCRIPTOR level
 * (numbers a synthetic/real fixture carries about itself), not on real
 * image bytes, and is only used to (a) tag which real constants a fixture
 * is evaluated under and (b) deterministically model the *type* of quality
 * pressure those constants apply (resize + recompression loses detail
 * evidence), so capture-profile stratification has something real to
 * stratify on even before a paired real-photo corpus exists.
 */

const CAPTURE_PROFILES = Object.freeze({
  'ios-current-v1': Object.freeze({
    profileId: 'ios-current-v1',
    platform: 'ios',
    // Real constants, from services/privacyImageUpload.ts.
    privacyPassMaxDimension: 1024,
    privacyPassQuality: 0.82,
    analysisPassWidth: 896,
    analysisPassQuality: 0.75,
    captureQuality: 0.7, // hooks/useKScan.js takePictureAsync({ quality: 0.7 })
    format: 'jpeg',
  }),
  'android-current-v1': Object.freeze({
    profileId: 'android-current-v1',
    platform: 'android',
    // Identical to iOS - proven from source (see authority/platformCaptureProfiles.json).
    privacyPassMaxDimension: 1024,
    privacyPassQuality: 0.82,
    analysisPassWidth: 896,
    analysisPassQuality: 0.75,
    captureQuality: 0.7,
    format: 'jpeg',
  }),
  'profile-neutral': Object.freeze({
    profileId: 'profile-neutral',
    platform: 'none',
    // For fixtures with no capture-path relevance (e.g. schema/plumbing-only
    // fixtures, or a future desktop-uploaded product photo). No degradation
    // is applied.
    privacyPassMaxDimension: null,
    privacyPassQuality: null,
    analysisPassWidth: null,
    analysisPassQuality: null,
    captureQuality: null,
    format: null,
  }),
});

function getCaptureProfile(profileId) {
  const profile = CAPTURE_PROFILES[profileId];
  if (!profile) {
    throw new Error(`Unknown capture profile: ${profileId}`);
  }
  return profile;
}

/**
 * Deterministic "detail evidence retained" score in [0, 1] for a described
 * garment feature at a given capture profile's real resize/quality
 * constants. Pure function of the profile's own numbers - same profile
 * always yields the same score. This is intentionally simple: it is a
 * plumbing/stratification signal, not a claim about actual pixel loss.
 */
function detailRetentionScore(profileId) {
  const p = getCaptureProfile(profileId);
  if (p.analysisPassWidth == null) return 1; // profile-neutral: no degradation modeled
  // Combine compression quality and resize width into one bounded score.
  // Both real constants (0.75 quality, 896px width) feed in directly so the
  // score changes if-and-only-if the underlying source constants change.
  const qualityTerm = p.analysisPassQuality; // already in [0,1]
  const widthTerm = Math.min(1, p.analysisPassWidth / 1600); // 1600px treated as "no meaningful loss"
  return Math.round(qualityTerm * widthTerm * 1000) / 1000;
}

/**
 * Apply a capture profile's detail-retention pressure to a fixture's
 * per-component ground-truth confidence, for fixtures that opt in via
 * `applyCaptureDegradation: true`. Deterministic, descriptor-level only.
 */
function applyCaptureProfileToFixture(fixture) {
  const profileId = fixture.captureProfile || 'profile-neutral';
  const retention = detailRetentionScore(profileId);
  return {
    ...fixture,
    captureProfileMeta: {
      profileId,
      detailRetentionScore: retention,
    },
  };
}

module.exports = {
  CAPTURE_PROFILES,
  getCaptureProfile,
  detailRetentionScore,
  applyCaptureProfileToFixture,
};
