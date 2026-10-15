'use strict';

const { resolveEasBuildProfile } = require('./resolve-eas-build-profiles');
const PROFILE = 'build35-testing';

function checkAndroidApkProfile(eas, environment = process.env) {
  if (environment.EAS_BUILD_PROFILE !== PROFILE) return { applicable: false };
  if (environment.EAS_BUILD_PLATFORM !== 'android') {
    throw new Error(`${PROFILE} is Android APK-only; iOS and store artifacts are forbidden.`);
  }
  const profile = resolveEasBuildProfile(eas, PROFILE);
  if (profile?.distribution !== 'internal' || profile?.android?.buildType !== 'apk' ||
      (profile.android.applicationArchivePath && !profile.android.applicationArchivePath.endsWith('.apk'))) {
    throw new Error(`${PROFILE} must produce an internal APK exclusively.`);
  }
  if (profile.environment !== 'production' ||
      profile.env?.EXPO_PUBLIC_VOICESCAN_ENABLED !== 'true' ||
      profile.env?.KSCAN_VOICE_NATIVE_CAPABILITY !== 'true' ||
      profile.env?.KSCAN_VOICE_CERTIFICATION === 'true' ||
      profile.env?.EXPO_PUBLIC_ELISE_SPEECH !== 'true' ||
      profile.env?.EXPO_PUBLIC_ELISE_V10 !== 'true') {
    throw new Error(`${PROFILE} must retain the approved Production-equivalent Elise/native capability matrix.`);
  }
  return { applicable: true, platform: 'android', artifact: 'apk', distribution: 'internal' };
}

if (require.main === module) {
  const result = checkAndroidApkProfile(require('../eas.json'));
  if (result.applicable) console.log('Elise APK build contract: Android / internal / APK-only verified.');
}

module.exports = { checkAndroidApkProfile };
