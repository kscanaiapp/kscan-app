const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const easConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
const appConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo;
const supabaseClientSource = fs.readFileSync(
  path.join(ROOT, 'services', 'supabaseClient.ts'),
  'utf8',
);

test('remote tester profiles target staging while production remains isolated', () => {
  const expectedRefs = {
    development: 'yzqjvdfgefveprobvvyw',
    preview: 'yzqjvdfgefveprobvvyw',
    production: 'wyyuqfdxucjksghsmhry',
  };

  for (const [profileName, expectedRef] of Object.entries(expectedRefs)) {
    const rawUrl = easConfig.build[profileName].env.EXPO_PUBLIC_SUPABASE_URL;
    const parsed = new URL(rawUrl);

    assert.equal(parsed.protocol, 'https:', profileName);
    assert.match(parsed.hostname, /^[a-z0-9]+\.supabase\.co$/, profileName);
    assert.doesNotMatch(parsed.hostname, /^(?:10\.0\.2\.2|localhost|127\.0\.0\.1)$/, profileName);
    assert.equal(parsed.hostname, `${expectedRef}.supabase.co`, profileName);
  }
});

test('remote tester and release profiles enable canonical scan-identify wiring', () => {
  for (const profileName of ['development', 'preview', 'production']) {
    const env = easConfig.build[profileName].env;

    assert.equal(env.EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED, 'true', profileName);
    assert.equal(env.EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED, 'true', profileName);
    assert.equal(env.EXPO_PUBLIC_API_URL, undefined, profileName);
  }
});

test('mobile auth scheme and package are shared across build profiles', () => {
  assert.equal(appConfig.scheme, 'kscan');
  assert.equal(appConfig.android.package, 'com.kscanai.app');
  assert.equal(appConfig.ios.bundleIdentifier, 'com.kscanai.app');
});

test('Supabase client reads explicit build environment without a local fallback', () => {
  assert.match(supabaseClientSource, /process\.env\.EXPO_PUBLIC_SUPABASE_URL/);
  assert.match(supabaseClientSource, /process\.env\.EXPO_PUBLIC_SUPABASE_ANON_KEY/);
  assert.match(supabaseClientSource, /validateSupabaseConfig\(configuredUrl, configuredAnonKey\)/);
  assert.match(supabaseClientSource, /Supabase configuration error \[\$\{configValidation\.code\}\]/);
  assert.doesNotMatch(supabaseClientSource, /10\.0\.2\.2|localhost|127\.0\.0\.1/);
});
