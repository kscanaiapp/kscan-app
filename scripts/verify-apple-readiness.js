#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function hasDependency(packageJson, name) {
  return Boolean(packageJson.dependencies?.[name] || packageJson.devDependencies?.[name]);
}

function createResult() {
  return {
    checks: [],
    warnings: [],
  };
}

function check(result, condition, label, detail = '') {
  result.checks.push({ ok: Boolean(condition), label, detail });
}

function warn(result, condition, label, detail = '') {
  if (!condition) {
    result.warnings.push({ label, detail });
  }
}

function getProductionSubmit(easJson) {
  return easJson.submit?.production?.ios ?? {};
}

function hasReviewInfo(storeConfig) {
  const review = storeConfig.apple?.review ?? {};
  return Boolean(
    review.firstName &&
      review.lastName &&
      review.phoneNumber &&
      review.emailAddress &&
      review.demoUsername &&
      review.demoPassword &&
      review.notes,
  );
}

function verify() {
  const result = createResult();
  const appJson = readJson('app.json').expo;
  const easJson = readJson('eas.json');
  const packageJson = readJson('package.json');
  const storeConfig = readJson('store.config.json');

  const ios = appJson.ios ?? {};
  const infoPlist = ios.infoPlist ?? {};
  const privacyManifests = ios.privacyManifests ?? {};
  const collectedTypes = (privacyManifests.NSPrivacyCollectedDataTypes ?? []).map(
    (entry) => entry.NSPrivacyCollectedDataType,
  );
  const accessedApiTypes = (privacyManifests.NSPrivacyAccessedAPITypes ?? []).map(
    (entry) => entry.NSPrivacyAccessedAPIType,
  );
  const productionBuild = easJson.build?.production ?? {};
  const productionSubmit = getProductionSubmit(easJson);
  const apple = storeConfig.apple ?? {};
  const englishInfo = apple.info?.['en-US'] ?? {};

  check(result, appJson.version === '1.0.1', 'Expo marketing version is 1.0.1');
  check(result, ios.bundleIdentifier === 'com.kscanai.app', 'iOS bundle ID is com.kscanai.app');
  check(result, /^\d+$/.test(ios.buildNumber ?? ''), 'iOS build number is a valid incrementing integer string');
  check(result, ios.supportsTablet === false, 'iPad support is disabled for this iPhone-only submission');
  check(
    result,
    infoPlist.ITSAppUsesNonExemptEncryption === false,
    'Non-exempt encryption flag is false',
  );
  check(
    result,
    infoPlist.NSCameraUsageDescription === 'K Scan uses your camera to photograph your outfit for style analysis.',
    'Camera usage description is present and scoped',
  );
  check(result, !('NSMicrophoneUsageDescription' in infoPlist), 'No microphone usage description is declared');
  check(
    result,
    infoPlist.NSPhotoLibraryUsageDescription ===
      'K Scan uses your photo library to let you upload style inspiration images to your Style Closet and Dressing Rooms.',
    'Photo library usage description is present and scoped',
  );
  check(result, privacyManifests.NSPrivacyTracking === false, 'Privacy manifest declares no tracking');
  check(
    result,
    Array.isArray(privacyManifests.NSPrivacyTrackingDomains) &&
      privacyManifests.NSPrivacyTrackingDomains.length === 0,
    'Privacy manifest has no tracking domains',
  );
  check(
    result,
    collectedTypes.includes('NSPrivacyCollectedDataTypeEmailAddress') &&
      collectedTypes.includes('NSPrivacyCollectedDataTypeUserID') &&
      collectedTypes.includes('NSPrivacyCollectedDataTypePhotosorVideos'),
    'Privacy manifest includes email, user ID, and photos/videos data types',
  );
  check(
    result,
    (privacyManifests.NSPrivacyCollectedDataTypes ?? []).every(
      (entry) => entry.NSPrivacyCollectedDataTypeTracking === false,
    ),
    'Collected data entries are not used for tracking',
  );
  check(
    result,
    accessedApiTypes.includes('NSPrivacyAccessedAPICategoryUserDefaults'),
    'Privacy manifest includes UserDefaults required-reason API entry',
  );

  check(result, productionBuild.distribution === 'store', 'EAS production build is store distribution');
  check(
    result,
    productionSubmit.metadataPath === './store.config.json',
    'EAS production submit points at store.config.json metadata',
  );

  check(result, apple.version === '1.0.1', 'App Store metadata version is 1.0.1');
  check(result, englishInfo.title === 'K Scan', 'App Store title is K Scan');
  check(result, englishInfo.subtitle === 'AI fashion discovery', 'App Store subtitle is scoped');
  check(result, englishInfo.privacyPolicyUrl === 'https://kscan.app/legal/privacy', 'Privacy URL is set');
  check(result, englishInfo.supportUrl === 'https://kscan.app/support', 'Support URL is set');
  check(result, apple.release?.automaticRelease === false, 'Release is manual after approval');
  check(result, apple.advisory?.kidsAgeBand === null, 'App is not configured as Made for Kids');
  check(result, apple.advisory?.ageRatingOverride === 'NONE', 'No unsupported age-rating override is encoded');

  check(result, hasDependency(packageJson, 'expo-apple-authentication'), 'Apple Sign-In dependency is present');
  check(result, ios.usesAppleSignIn === true, 'Apple Sign-In entitlement is declared');
  check(result, !hasDependency(packageJson, 'expo-media-library'), 'No media library dependency');
  check(result, !hasDependency(packageJson, 'expo-ads-admob'), 'No ads dependency');
  check(result, !hasDependency(packageJson, 'expo-tracking-transparency'), 'No App Tracking Transparency dependency');

  warn(result, Boolean(productionSubmit.ascAppId), 'App Store Connect app ID is not configured in eas.json');
  warn(result, hasReviewInfo(storeConfig), 'App Review contact and demo account are not encoded in store.config.json');
  warn(result, false, 'EAS iOS credentials still require interactive Apple Developer validation');

  return result;
}

function printResult(result) {
  for (const item of result.checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.label}${item.detail ? ` - ${item.detail}` : ''}`);
  }

  for (const item of result.warnings) {
    console.log(`WARN ${item.label}${item.detail ? ` - ${item.detail}` : ''}`);
  }
}

function main() {
  const result = verify();
  printResult(result);

  const failures = result.checks.filter((item) => !item.ok);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  hasReviewInfo,
  verify,
};
