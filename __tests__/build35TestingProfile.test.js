const test = require('node:test');
const assert = require('node:assert/strict');
const eas = require('../eas.json');

test('Build 35 internal APK uses production certification flags, not bare production defaults', () => {
  const profile = eas.build['build35-testing'];
  assert.equal(profile.extends, 'production-certification');
  assert.equal(profile.environment, 'production');
  assert.equal(profile.distribution, 'internal');
  assert.equal(profile.android.buildType, 'apk');
  const certification = eas.build[profile.extends];
  assert.equal(certification.extends, 'production');
  for (const name of ['EXPO_PUBLIC_VTO_UI_ENABLED', 'EXPO_PUBLIC_PACKING_INTELLIGENCE_V1', 'EXPO_PUBLIC_ELISE_CONCIERGE_V1', 'EXPO_PUBLIC_SMART_WATCHLIST_V1']) {
    assert.equal(certification.env[name], 'true', name);
  }
  assert.equal(
    certification.env.EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED,
    'false',
    'legacy complimentary K+ must stay disabled in the Build 35 candidate',
  );
  assert.equal(eas.build.production.env.EXPO_PUBLIC_SUPABASE_URL, 'https://wyyuqfdxucjksghsmhry.supabase.co');
});
