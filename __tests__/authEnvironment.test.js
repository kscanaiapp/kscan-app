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

test('remote tester and release profiles target one non-local Supabase project', () => {
  const projectHosts = [];

  for (const profileName of ['development', 'preview', 'production']) {
    const rawUrl = easConfig.build[profileName].env.EXPO_PUBLIC_SUPABASE_URL;
    const parsed = new URL(rawUrl);

    assert.equal(parsed.protocol, 'https:', profileName);
    assert.match(parsed.hostname, /^[a-z0-9]+\.supabase\.co$/, profileName);
    assert.doesNotMatch(parsed.hostname, /^(?:10\.0\.2\.2|localhost|127\.0\.0\.1)$/, profileName);
    projectHosts.push(parsed.hostname);
  }

  assert.equal(new Set(projectHosts).size, 1);
});

test('mobile auth scheme and package are shared across build profiles', () => {
  assert.equal(appConfig.scheme, 'kscan');
  assert.equal(appConfig.android.package, 'com.kscanai.app');
  assert.equal(appConfig.ios.bundleIdentifier, 'com.kscanai.app');
});

test('Supabase client reads explicit build environment without a local fallback', () => {
  assert.match(supabaseClientSource, /process\.env\.EXPO_PUBLIC_SUPABASE_URL/);
  assert.match(supabaseClientSource, /process\.env\.EXPO_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(supabaseClientSource, /10\.0\.2\.2|localhost|127\.0\.0\.1/);
});
