const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRoutingGuardState,
  isAuthCallbackUrl,
  isPublicRoute,
  isSessionUsable,
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
