const PUBLIC_ROUTES = new Set([
  '/auth',
  '/auth/callback',
  '/auth/reset',
  '/auth/update-password',
  '/onboarding',
  '/account/restore',
]);

const LIMITED_ACCOUNT_ROUTES = new Set(['/privacy', '/account/restore']);

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

function isOnboardingRoute(pathname) {
  return normalizePathname(pathname) === '/onboarding';
}

function isAuthCallbackUrl(url) {
  return /(^|\/)auth\/callback($|[?#/])/.test(String(url || ''));
}

function isAuthSessionRoute(pathname) {
  const normalized = normalizePathname(pathname);
  return normalized === '/auth/callback' || normalized === '/auth/update-password';
}

function isLimitedAccountRoute(pathname) {
  return LIMITED_ACCOUNT_ROUTES.has(normalizePathname(pathname));
}

function isSessionUsable(session, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!session) return false;
  if (typeof session.expires_at === 'number' && session.expires_at <= nowSeconds) {
    return false;
  }
  return true;
}

function hasPendingDeletionProfile(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return profile.account_status === 'pending_deletion' || Boolean(profile.account_locked_at);
}

function getRoutingGuardState({ pathname, loading, session, nowSeconds, profile, profileLoading, onboardingComplete = null }) {
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

  if (isAuthSessionRoute(normalizedPathname)) {
    return { action: 'allow', pathname: normalizedPathname, redirectTo: null };
  }

  if (profileLoading) {
    return { action: 'loading', pathname: normalizedPathname, redirectTo: null };
  }

  if (hasPendingDeletionProfile(profile)) {
    if (isLimitedAccountRoute(normalizedPathname)) {
      return { action: 'allow', pathname: normalizedPathname, redirectTo: null };
    }
    return { action: 'redirect', pathname: normalizedPathname, redirectTo: '/privacy' };
  }

  if (onboardingComplete === null || onboardingComplete === undefined) {
    return { action: 'loading', pathname: normalizedPathname, redirectTo: null };
  }

  if (!onboardingComplete) {
    if (isOnboardingRoute(normalizedPathname)) {
      return { action: 'allow', pathname: normalizedPathname, redirectTo: null };
    }
    return {
      action: 'redirect',
      pathname: normalizedPathname,
      redirectTo: '/onboarding?resume=terms',
    };
  }

  if (isAuthEntryRoute(normalizedPathname) || isOnboardingRoute(normalizedPathname)) {
    return { action: 'redirect', pathname: normalizedPathname, redirectTo: '/' };
  }

  return { action: 'allow', pathname: normalizedPathname, redirectTo: null };
}

module.exports = {
  LIMITED_ACCOUNT_ROUTES,
  PUBLIC_ROUTES,
  getRoutingGuardState,
  hasPendingDeletionProfile,
  isAuthCallbackUrl,
  isAuthSessionRoute,
  isLimitedAccountRoute,
  isOnboardingRoute,
  isPublicRoute,
  isSessionUsable,
  normalizePathname,
};
