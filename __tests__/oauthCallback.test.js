/**
 * OAuth Callback Plumbing Tests
 *
 * Verifies the deep-link / callback chain without invoking any live OAuth
 * providers or browser sessions.
 *
 * Full callback chain (for reference):
 *   openAuthSessionAsync(url, 'kscan://auth/callback')
 *     -> browser completes OAuth -> redirects to kscan://auth/callback?code=...
 *     -> Android: launchMode=singleTask delivers intent to MainActivity
 *     -> Expo Router cold-start: Linking.getInitialURL() captures it
 *     -> AuthGate.waitingForAuthCallbackRoute === true -> Stack renders immediately
 *     -> /auth/callback route handles: parseAuthCallbackUrl -> exchangeCodeForSession
 *     -> session set -> auth effect -> redirect to / or /onboarding?resume=terms
 *
 * Apple sign-in uses a separate native flow (ASAuthorizationAppleIDProvider)
 * and is not routed through the deep-link path - untouched by this fix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AUTH_CALLBACK_URL } = require('../services/authConfig');
const { parseAuthCallbackUrl, buildAuthCallbackUrlFromParams, getAuthCallbackRedirect } = require('../services/authDeepLink');
const { isAuthCallbackUrl, getRoutingGuardState, isPublicRoute } = require('../services/routingGuard');

const NOW = 1000;
const authScreenSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'auth', 'index.tsx'),
  'utf8',
);
const onboardingSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'onboarding', 'index.tsx'),
  'utf8',
);

// -- 1. AUTH_CALLBACK_URL matches the kscan:// scheme in app.json ------------
test('AUTH_CALLBACK_URL uses the kscan:// deep-link scheme registered in app.json', () => {
  assert.equal(AUTH_CALLBACK_URL, 'kscan://auth/callback');
  assert.ok(AUTH_CALLBACK_URL.startsWith('kscan://'), 'must use native kscan:// scheme, not https://');
});

// -- 2. isAuthCallbackUrl detects all valid callback URL forms ----------------
test('kscan://auth/callback URLs are recognised as auth callback deep links', () => {
  assert.equal(isAuthCallbackUrl('kscan://auth/callback?code=abc123'), true);
  assert.equal(isAuthCallbackUrl('kscan://auth/callback#access_token=tok&refresh_token=ref'), true);
  assert.equal(isAuthCallbackUrl('kscan://auth/callback?token_hash=hash&type=email'), true);
  // Non-callback paths are not recognised:
  assert.equal(isAuthCallbackUrl('kscan://scan'), false);
  assert.equal(isAuthCallbackUrl(null), false);
  assert.equal(isAuthCallbackUrl(''), false);
});

// -- 3. /auth/callback is a public route - not blocked by the guard -----------
test('/auth/callback route is public and allowed without an active session', () => {
  const state = getRoutingGuardState({
    pathname: '/auth/callback',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'allow');
  assert.equal(isPublicRoute('/auth/callback'), true);
});

// -- 4. PKCE code is correctly extracted from a callback query string ---------
test('parseAuthCallbackUrl extracts PKCE code from callback query string', () => {
  const result = parseAuthCallbackUrl('kscan://auth/callback?code=pkce_code_abc123');
  assert.equal(result.code, 'pkce_code_abc123');
  assert.equal(result.error, null);
  assert.equal(result.hasSessionTokens, false);
});

// -- 5. Implicit tokens are extracted from fragment-style callback ------------
test('parseAuthCallbackUrl extracts access_token + refresh_token from callback fragment', () => {
  const result = parseAuthCallbackUrl(
    'kscan://auth/callback#access_token=at_abc&refresh_token=rt_xyz'
  );
  assert.equal(result.accessToken, 'at_abc');
  assert.equal(result.refreshToken, 'rt_xyz');
  assert.equal(result.hasSessionTokens, true);
  assert.equal(result.code, null);
});

// -- 6. token_hash + type pair is extracted for OTP / magic-link flow ---------
test('parseAuthCallbackUrl extracts token_hash and type for OTP / magic-link flows', () => {
  const result = parseAuthCallbackUrl(
    'kscan://auth/callback?token_hash=hash_abc&type=email'
  );
  assert.equal(result.tokenHash, 'hash_abc');
  assert.equal(result.type, 'email');
  assert.equal(result.hasTokenHash, true);
});

// -- 7. Error param is surfaced correctly -------------------------------------
test('parseAuthCallbackUrl surfaces error description from callback URL', () => {
  const result = parseAuthCallbackUrl(
    'kscan://auth/callback?error=access_denied&error_description=User+cancelled'
  );
  assert.equal(result.error, 'User cancelled');
  assert.equal(result.code, null);
  assert.equal(result.hasSessionTokens, false);
});

// -- 8. buildAuthCallbackUrlFromParams reconstructs a valid callback URL ------
test('buildAuthCallbackUrlFromParams produces a kscan:// callback URL from params', () => {
  const url = buildAuthCallbackUrlFromParams({ code: 'abc123' });
  assert.ok(url, 'must return a non-null URL');
  assert.ok(url.startsWith('kscan://auth/callback?'), 'must use kscan:// scheme');
  assert.ok(url.includes('code=abc123'), 'must include the code param');
});

// -- 9. Recovery token type routes to update-password screen -----------------
test('getAuthCallbackRedirect sends recovery tokens to /auth/update-password', () => {
  const recoveryParsed = parseAuthCallbackUrl(
    'kscan://auth/callback?token_hash=hash&type=recovery'
  );
  assert.equal(recoveryParsed.isRecovery, true);
  assert.equal(getAuthCallbackRedirect(recoveryParsed), '/auth/update-password');
});

// -- 10. Non-recovery callback routes to home ---------------------------------
test('getAuthCallbackRedirect sends a normal login callback to home (/)', () => {
  const normalParsed = parseAuthCallbackUrl('kscan://auth/callback?code=abc');
  assert.equal(normalParsed.isRecovery, false);
  assert.equal(getAuthCallbackRedirect(normalParsed), '/');
});

// 11. True Google browser cancellation remains user-safe
test('Google OAuth cancel and dismiss paths still show Sign-in cancelled', () => {
  assert.match(
    authScreenSource,
    /result\.type === 'cancel' \|\| result\.type === 'dismiss'[\s\S]{0,160}setError\('Sign-in cancelled\.'\)/,
  );
  assert.match(
    onboardingSource,
    /result\.type === 'cancel' \|\| result\.type === 'dismiss'[\s\S]{0,180}setCreateError\('Sign-in cancelled\.'\)/,
  );
});

// 12. Apple sign-in remains a separate native id-token flow
test('Apple sign-in stays separate from the Google deep-link browser flow', () => {
  assert.match(authScreenSource, /AppleAuthentication\.signInAsync/);
  assert.match(authScreenSource, /signInWithIdToken\(\{[\s\S]*?provider: 'apple'/);
  assert.doesNotMatch(authScreenSource, /provider: 'apple'[\s\S]{0,240}openAuthSessionAsync/);
});
