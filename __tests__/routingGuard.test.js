const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRoutingGuardState,
  isAuthCallbackUrl,
  isPublicRoute,
  isSessionUsable,
  shouldCommitRouteNavigation,
  shouldPreserveAuthNavigatorDuringLoading,
} = require('../services/routingGuard');

const NOW = 1000;
const validSession = { access_token: 'access-token', expires_at: NOW + 3600 };
const expiredSession = { access_token: 'access-token', expires_at: NOW - 1 };
const pendingProfile = { account_status: 'pending_deletion', age_group: 'unknown' };
const lockedProfile = { account_status: 'active', age_group: 'unknown', account_locked_at: '2026-06-12T12:00:00Z' };

test('launch without an active session redirects to /auth', () => {
  const state = getRoutingGuardState({ pathname: '/', loading: false, session: null, nowSeconds: NOW });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/auth');
});

test('launch with a valid active session allows authenticated app entry', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: true,
  });
  assert.equal(state.action, 'allow');
  assert.equal(state.redirectTo, null);
});

test('authenticated app entry waits for onboarding completion lookup', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: null,
  });
  assert.equal(state.action, 'loading');
  assert.equal(state.redirectTo, null);
});

test('authenticated users with incomplete onboarding resume terms before app entry', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: false,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/onboarding?resume=terms');
});

test('bootstrap loading renders loading policy before any route content', () => {
  const state = getRoutingGuardState({ pathname: '/', loading: true, session: null, nowSeconds: NOW });
  assert.equal(state.action, 'loading');
  assert.equal(state.redirectTo, null);
});

test('direct protected route access while signed out redirects to /auth', () => {
  for (const pathname of ['/', '/scan', '/privacy', '/library']) {
    const state = getRoutingGuardState({ pathname, loading: false, session: null, nowSeconds: NOW });
    assert.equal(state.action, 'redirect', pathname);
    assert.equal(state.redirectTo, '/auth', pathname);
  }
});

test('public auth routes are allowed while signed out', () => {
  for (const pathname of ['/auth', '/auth/callback', '/auth/reset', '/auth/update-password']) {
    const state = getRoutingGuardState({ pathname, loading: false, session: null, nowSeconds: NOW });
    assert.equal(state.action, 'allow', pathname);
    assert.equal(state.redirectTo, null, pathname);
    assert.equal(isPublicRoute(pathname), true, pathname);
  }
});

test('deep-link callback route is not blocked by the auth gate', () => {
  const state = getRoutingGuardState({
    pathname: '/auth/callback',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'allow');
});

test('implemented auth callback deep-link URL is detected for cold-start passthrough', () => {
  assert.equal(isAuthCallbackUrl('kscan://auth/callback?code=abc123'), true);
  assert.equal(isAuthCallbackUrl('kscan://auth/callback#error=denied'), true);
  assert.equal(isAuthCallbackUrl('kscan://scan'), false);
});

test('AuthGate owns the destination after callback session establishment', () => {
  const hydrating = getRoutingGuardState({
    pathname: '/auth/callback',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: null,
  });
  const complete = getRoutingGuardState({
    pathname: '/auth/callback',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: true,
  });
  const incomplete = getRoutingGuardState({
    pathname: '/auth/callback',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: false,
  });

  assert.deepEqual(hydrating, {
    action: 'loading',
    pathname: '/auth/callback',
    redirectTo: null,
  });
  assert.equal(complete.action, 'redirect');
  assert.equal(complete.redirectTo, '/');
  assert.equal(incomplete.action, 'redirect');
  assert.equal(incomplete.redirectTo, '/onboarding?resume=terms');
});

test('repeated callback guard evaluation is stable and does not oscillate', () => {
  const input = {
    pathname: '/auth/callback',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: true,
  };
  assert.deepEqual(getRoutingGuardState(input), getRoutingGuardState(input));
});

test('route commitment skips the current route and a duplicate requested destination', () => {
  assert.equal(
    shouldCommitRouteNavigation({
      pathname: '/',
      previousRequestedDestination: null,
      requestedDestination: '/',
    }),
    false,
  );
  assert.equal(
    shouldCommitRouteNavigation({
      pathname: '/auth/callback',
      previousRequestedDestination: '/',
      requestedDestination: '/',
    }),
    false,
  );
  assert.equal(
    shouldCommitRouteNavigation({
      pathname: '/auth/callback',
      previousRequestedDestination: null,
      requestedDestination: '/',
    }),
    true,
  );
});

test('five repeated OAuth routing cycles produce one stable destination per cycle', () => {
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const pending = getRoutingGuardState({
      pathname: '/auth/callback',
      loading: false,
      session: validSession,
      nowSeconds: NOW,
      onboardingComplete: null,
    });
    const resolved = getRoutingGuardState({
      pathname: '/auth/callback',
      loading: false,
      session: validSession,
      nowSeconds: NOW,
      onboardingComplete: true,
    });
    const stable = getRoutingGuardState({
      pathname: '/',
      loading: false,
      session: validSession,
      nowSeconds: NOW,
      onboardingComplete: true,
    });

    assert.equal(pending.action, 'loading', `cycle ${cycle + 1}`);
    assert.equal(resolved.redirectTo, '/', `cycle ${cycle + 1}`);
    assert.equal(stable.action, 'allow', `cycle ${cycle + 1}`);
  }
});

test('post-OAuth hydration keeps the navigator mounted so Android cannot replay the callback', () => {
  assert.equal(
    shouldPreserveAuthNavigatorDuringLoading({
      authCallbackSeen: true,
      guardAction: 'loading',
      session: validSession,
    }),
    true,
  );
  assert.equal(
    shouldPreserveAuthNavigatorDuringLoading({
      authCallbackSeen: false,
      guardAction: 'loading',
      session: validSession,
    }),
    false,
    'helper remains callback-scoped; AuthGate always mounts Stack separately',
  );
  assert.equal(
    shouldPreserveAuthNavigatorDuringLoading({
      authCallbackSeen: true,
      guardAction: 'loading',
      session: null,
    }),
    false,
    'a callback without an authenticated session never exposes the navigator',
  );
});

test('AuthGate source always mounts Stack during loading and does not clear redirect dedupe on loading', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const authGateSource = fs.readFileSync(path.join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
  assert.match(
    authGateSource,
    /if \(guardState\.action === 'loading'\)[\s\S]*<Stack screenOptions=\{\{ headerShown: false \}\} \/>/,
  );
  assert.doesNotMatch(authGateSource, /styles\.loadingRoot/);
  assert.match(
    authGateSource,
    /if \(guardState\.action === 'allow'\) \{\s*lastRedirectRef\.current = null;/,
  );
  assert.doesNotMatch(
    authGateSource,
    /if \(guardState\.action !== 'redirect'\) \{\s*lastRedirectRef\.current = null;/,
  );
});

test('clearing session routes protected screens to /auth', () => {
  const signedIn = getRoutingGuardState({
    pathname: '/privacy',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: true,
  });
  const signedOut = getRoutingGuardState({
    pathname: '/privacy',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });

  assert.equal(signedIn.action, 'allow');
  assert.equal(signedOut.action, 'redirect');
  assert.equal(signedOut.redirectTo, '/auth');
});

test('authenticated users on auth entry are replaced to app entry', () => {
  const state = getRoutingGuardState({
    pathname: '/auth',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: true,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/');
});

test('expired sessions are treated as signed out', () => {
  assert.equal(isSessionUsable(expiredSession, NOW), false);

  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: expiredSession,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/auth');
});

test('authenticated pending-deletion accounts are limited to privacy controls', () => {
  for (const pathname of ['/', '/scan', '/library', '/auth']) {
    const state = getRoutingGuardState({
      pathname,
      loading: false,
      session: validSession,
      profile: pendingProfile,
      nowSeconds: NOW,
    });
    assert.equal(state.action, 'redirect', pathname);
    assert.equal(state.redirectTo, '/privacy', pathname);
  }

  const privacyState = getRoutingGuardState({
    pathname: '/privacy',
    loading: false,
    session: validSession,
    profile: pendingProfile,
    nowSeconds: NOW,
  });
  assert.equal(privacyState.action, 'allow');
});

test('account lock timestamp also limits authenticated app entry', () => {
  const state = getRoutingGuardState({
    pathname: '/scan',
    loading: false,
    session: validSession,
    profile: lockedProfile,
    nowSeconds: NOW,
  });

  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/privacy');
});

test('authenticated app entry waits for profile status before allowing protected routes', () => {
  const state = getRoutingGuardState({
    pathname: '/scan',
    loading: false,
    session: validSession,
    profileLoading: true,
    nowSeconds: NOW,
  });

  assert.equal(state.action, 'loading');
  assert.equal(state.redirectTo, null);
});
