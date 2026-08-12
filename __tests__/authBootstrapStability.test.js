/**
 * Source-level regressions for native auth bootstrap stability.
 *
 * Root causes previously observed on Android:
 *   - AuthGate unmounted <Stack> during ordinary loading → max update depth
 *   - Privacy hydrate depended on access_token → token refresh re-gated routing
 *   - Transient loading cleared redirect dedupe → repeated router.replace
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const layoutSource = fs.readFileSync(path.join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
const privacySource = fs.readFileSync(
  path.join(__dirname, '..', 'contexts', 'PrivacyPreferencesContext.tsx'),
  'utf8',
);
const supabaseClientSource = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'supabaseClient.ts'),
  'utf8',
);

test('AuthGate keeps Stack mounted for every loading state', () => {
  assert.match(
    layoutSource,
    /if \(guardState\.action === 'loading'\) \{\s*return \(\s*<>\s*<Stack/,
  );
  assert.doesNotMatch(layoutSource, /styles\.loadingRoot/);
});

test('AuthGate clears redirect dedupe only after allow', () => {
  assert.match(
    layoutSource,
    /if \(guardState\.action === 'allow'\) \{\s*lastRedirectRef\.current = null;/,
  );
  assert.doesNotMatch(
    layoutSource,
    /if \(guardState\.action !== 'redirect'\) \{\s*lastRedirectRef\.current = null;/,
  );
});

test('privacy hydrate keys off actor id, not access_token refresh', () => {
  assert.match(privacySource, /session\?\.user\?\.id/);
  assert.doesNotMatch(
    privacySource,
    /\[session\?\.access_token,\s*authLoading,\s*hydrate\]/,
  );
  assert.match(privacySource, /gateRouting/);
  assert.match(
    privacySource,
    /Same-actor[\s\S]{0,80}must not flip/,
  );
});

test('privacy hydrate cancels stale generations and does not wipe remote rows while refreshing', () => {
  assert.match(privacySource, /hydrateGenerationRef/);
  assert.match(privacySource, /else if \(!auth\.isAuthenticated\)/);
  assert.doesNotMatch(
    privacySource,
    /Signed out or refreshing[\s\S]{0,80}setRemoteRow\(null\)/,
  );
});

test('Supabase client remains a module singleton with validated fail-closed auth configuration', () => {
  assert.match(supabaseClientSource, /export const supabase = createClient/);
  assert.match(supabaseClientSource, /validateSupabaseConfig\(configuredUrl, configuredAnonKey\)/);
  assert.match(supabaseClientSource, /export function assertSupabaseConfigured/);
  assert.match(supabaseClientSource, /missing-supabase-url\.supabase\.co/);
  assert.equal(
    (supabaseClientSource.match(/createClient\(/g) || []).length,
    2,
    'one main client + one bootstrap refresh client',
  );
});
