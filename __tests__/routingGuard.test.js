const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRoutingGuardState,
  isAuthCallbackUrl,
  isPublicRoute,
  isSessionUsable,
  shouldDeferToAuthCallbackRoute,
} = require('../services/routingGuard');

const NOW = 1000;
const validSession = { access_token: 'access-token', expires_at: NOW + 3600 };
const expiredSession = { access_token: 'access-token', expires_at: NOW - 1 };

test('launch without an active session redirects to /auth', () => {
  const state = getRoutingGuardState({ pathname: '/', loading: false, session: null, nowSeconds: NOW });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/auth');
});

test('launch with a valid active session allows authenticated app entry', () => {
  const state = getRoutingGuardState({ pathname: '/', loading: false, session: validSession, nowSeconds: NOW });
  assert.equal(state.action, 'allow');
  assert.equal(state.redirectTo, null);
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

test('successful callback session establishment can proceed to authenticated destination', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'allow');
});

test('clearing session routes protected screens to /auth', () => {
  const signedIn = getRoutingGuardState({
    pathname: '/privacy',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
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

// ── Cold-start auth-callback deferral ────────────────────────────────────────
//
// The root layout holds the auth guard open while expo-router settles onto a
// cold-start auth-callback deep link. Linking.getInitialURL() keeps returning
// that URL for the whole process lifetime, so the deferral must be latched shut
// once the callback route has been reached — otherwise the guard stays disabled
// for every later navigation in a session that began with a magic link.

const CALLBACK_URL = 'kscan://auth/callback#access_token=a&refresh_token=b&type=signup';

test('deferral holds while routing to the cold-start callback route', () => {
  assert.equal(
    shouldDeferToAuthCallbackRoute({
      initialUrlChecked: true,
      initialUrl: CALLBACK_URL,
      pathname: '/',
      callbackRouteSettled: false,
    }),
    true,
  );
});

test('deferral does not apply before the initial URL has been read', () => {
  assert.equal(
    shouldDeferToAuthCallbackRoute({
      initialUrlChecked: false,
      initialUrl: null,
      pathname: '/',
      callbackRouteSettled: false,
    }),
    false,
  );
});

test('deferral does not apply once the callback route is showing', () => {
  assert.equal(
    shouldDeferToAuthCallbackRoute({
      initialUrlChecked: true,
      initialUrl: CALLBACK_URL,
      pathname: '/auth/callback',
      callbackRouteSettled: false,
    }),
    false,
  );
});

test('deferral releases permanently once the callback route has been settled', () => {
  // This is the regression: the callback screen replaces to '/', pathname is no
  // longer '/auth/callback', and initialUrl still holds the cold-start deep
  // link. Before the latch this re-opened the bypass for the rest of the
  // process and no expired session could ever be redirected to /auth.
  assert.equal(
    shouldDeferToAuthCallbackRoute({
      initialUrlChecked: true,
      initialUrl: CALLBACK_URL,
      pathname: '/',
      callbackRouteSettled: true,
    }),
    false,
  );

  for (const pathname of ['/', '/scan', '/library', '/dressing-rooms', '/privacy']) {
    assert.equal(
      shouldDeferToAuthCallbackRoute({
        initialUrlChecked: true,
        initialUrl: CALLBACK_URL,
        pathname,
        callbackRouteSettled: true,
      }),
      false,
      `guard must be active again on ${pathname} after a link-started session`,
    );
  }
});

test('a non-callback cold-start URL never defers the guard', () => {
  for (const url of [null, '', 'kscan://scan', 'https://kscan.app/rooms/tok']) {
    assert.equal(
      shouldDeferToAuthCallbackRoute({
        initialUrlChecked: true,
        initialUrl: url,
        pathname: '/',
        callbackRouteSettled: false,
      }),
      false,
      `${String(url)} must not defer the auth guard`,
    );
  }
});

test('after the deferral releases, an expired session still redirects to /auth', () => {
  // End-to-end of the repaired behaviour: link-started session, guard released,
  // token expires, protected route -> redirect.
  assert.equal(
    shouldDeferToAuthCallbackRoute({
      initialUrlChecked: true,
      initialUrl: CALLBACK_URL,
      pathname: '/library',
      callbackRouteSettled: true,
    }),
    false,
  );

  const state = getRoutingGuardState({
    pathname: '/library',
    loading: false,
    session: expiredSession,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/auth');
});

test('the root layout latches the deferral rather than recomputing it from initialUrl alone', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const layout = fs.readFileSync(
    path.join(__dirname, '..', 'app', '_layout.tsx'),
    'utf8',
  );
  assert.match(layout, /shouldDeferToAuthCallbackRoute\(/);
  assert.match(layout, /callbackRouteSettled/);
  assert.match(
    layout,
    /AUTH_CALLBACK_ROUTE_GRACE_MS/,
    'a deep link that never routes must not disable the guard indefinitely',
  );
});
