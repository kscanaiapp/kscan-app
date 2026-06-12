const PUBLIC_ROUTES = new Set([
  '/auth',
  '/auth/callback',
  '/auth/reset',
  '/auth/update-password',
]);

function normalizePathname(pathname) {
  if (!pathname || pathname === '') return '/';
  const path = String(pathname).split('?')[0].split('#')[0] || '/';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function isPublicRoute(pathname) {
  const normalized = normalizePathname(pathname);
  if (PUBLIC_ROUTES.has(normalized)) return true;
  // Shared room views are unauthenticated — token is validated server-side.
  if (/^\/rooms\/[A-Za-z0-9_-]+$/.test(normalized)) return true;
  return false;
}

function isAuthEntryRoute(pathname) {
  return normalizePathname(pathname) === '/auth';
}

function isAuthCallbackUrl(url) {
  return /(^|\/)auth\/callback($|[?#/])/.test(String(url || ''));
}

function isSessionUsable(session, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!session) return false;
  if (typeof session.expires_at === 'number' && session.expires_at <= nowSeconds) {
    return false;
  }
  return true;
}

function getRoutingGuardState({ pathname, loading, session, nowSeconds }) {
  const normalizedPathname = normalizePathname(pathname);
  const hasUsableSession = isSessionUsable(session, nowSeconds);

  if (loading) {
    return { action: 'loading', pathname: normalizedPathname, redirectTo: null };
  }

  if (!hasUsableSession) {
    if (isPublicRoute(normalizedPathname)) {
      return { action: 'allow', pathname: normalizedPathname, redirectTo: null };
    }
    return { action: 'redirect', pathname: normalizedPathname, redirectTo: '/auth' };
  }

  if (isAuthEntryRoute(normalizedPathname)) {
    return { action: 'redirect', pathname: normalizedPathname, redirectTo: '/' };
  }

  return { action: 'allow', pathname: normalizedPathname, redirectTo: null };
}

module.exports = {
  PUBLIC_ROUTES,
  getRoutingGuardState,
  isAuthCallbackUrl,
  isPublicRoute,
  isSessionUsable,
  normalizePathname,
};
