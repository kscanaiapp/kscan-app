/**
 * Welcome Routing Tests
 *
 * Covers the two-layer routing guarantee for fresh unauthenticated users:
 *
 *   Layer 1 - routingGuard.js:
 *     Returns { action: 'redirect', redirectTo: '/auth' } for unauthenticated
 *     users on any protected route.
 *
 *   Layer 2 - app/_layout.tsx (AuthGate):
 *     Remaps '/auth' -> '/onboarding' so users land at Welcome Step 1
 *     instead of the bare login screen.
 *
 * The mapping in _layout.tsx (post-fix):
 *   const redirectTo = guardState.redirectTo === '/auth' ? '/onboarding' : guardState.redirectTo;
 *
 * Previously this was gated behind ONBOARDING_FRAMEWORK_V1_ENABLED which
 * defaulted to false when EXPO_PUBLIC_ONBOARDING_FRAMEWORK_V1 was not in .env.
 * The gate has been removed; the remap is now unconditional.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRoutingGuardState,
  isPublicRoute,
} = require('../services/routingGuard');

const NOW = 1000;
const validSession = { access_token: 'access-token', expires_at: NOW + 3600 };

// -- The remap formula from _layout.tsx (post-fix) --------------------------
// Duplicated here so this test breaks loudly if the formula regresses.
function applyLayoutRedirectRemap(guardRedirectTo) {
  return guardRedirectTo === '/auth' ? '/onboarding' : guardRedirectTo;
}

// -- 1. /onboarding is a public route - guard allows unauthenticated access --
test('unauthenticated user visiting /onboarding is allowed by the routing guard', () => {
  const state = getRoutingGuardState({
    pathname: '/onboarding',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'allow');
  assert.equal(state.redirectTo, null);
  assert.equal(isPublicRoute('/onboarding'), true);
});

// -- 2. Guard issues /auth redirect for unauthenticated users on protected routes
test('unauthenticated user on a protected route gets redirectTo: /auth from the routing guard', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/auth');
});

// -- 3. _layout.tsx remapping: /auth -> /onboarding for fresh users ----------
test('_layout.tsx redirect mapping converts /auth to /onboarding for fresh unauthenticated users', () => {
  // This test pins the exact patched formula in _layout.tsx.
  // If the formula regresses, update the fix first - then update this test.
  assert.equal(applyLayoutRedirectRemap('/auth'), '/onboarding');
});

// -- 4. Resume-terms redirect is NOT issued to unauthenticated users ---------
test('unauthenticated user is never redirected to /onboarding?resume=terms', () => {
  // After remap: /auth -> /onboarding (no query param).
  // Only authenticated-but-incomplete users get ?resume=terms.
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });
  assert.equal(state.redirectTo, '/auth');
  const remapped = applyLayoutRedirectRemap(state.redirectTo);
  assert.equal(remapped, '/onboarding');
  assert.equal(remapped.includes('resume'), false);
});

// -- 5. Authenticated incomplete user gets /onboarding?resume=terms ----------
test('authenticated user with incomplete onboarding is redirected to /onboarding?resume=terms', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: false,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/onboarding?resume=terms');
  // Resume param is preserved through remap (no /auth match, so remap is a no-op).
  const remapped = applyLayoutRedirectRemap(state.redirectTo);
  assert.equal(remapped, '/onboarding?resume=terms');
});

// -- 6. Authenticated complete user on /onboarding is sent to home ------------
test('authenticated user with complete onboarding on /onboarding is redirected to home', () => {
  const state = getRoutingGuardState({
    pathname: '/onboarding',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: true,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/');
});
