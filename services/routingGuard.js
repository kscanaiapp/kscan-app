const PUBLIC_ROUTES = new Set([
  '/auth',
  '/auth/callback',
  '/auth/reset',
  '/auth/update-password',
  '/onboarding',
]);

const LIMITED_ACCOUNT_ROUTES = new Set(['/privacy']);

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

function isPasswordRecoveryRoute(pathname) {
  return normalizePathname(pathname) === '/auth/update-password';
}

function shouldPreserveAuthNavigatorDuringLoading({
  authCallbackSeen,
  guardAction,
  session,
}) {
  return Boolean(authCallbackSeen && session && guardAction === 'loading');
}

function shouldCommitRouteNavigation({
  pathname,
  previousRequestedDestination,
  requestedDestination,
}) {
  if (!requestedDestination) return false;
  if (normalizePathname(pathname) === normalizePathname(requestedDestination)) return false;
  return previousRequestedDestination !== requestedDestination;
}

function isLimitedAccountRoute(pathname) {
  return LIMITED_ACCOUNT_ROUTES.has(normalizePathname(pathname));
}

const AUTH_STATE = {
  UNKNOWN: 'AUTH_UNKNOWN',
  AUTHENTICATED: 'AUTHENTICATED',
  RECOVERY_PENDING: 'AUTHENTICATED_RECOVERY_PENDING',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
};

function isAccessTokenExpired(session, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!session) return true;
  return typeof session.expires_at === 'number' && session.expires_at <= nowSeconds;
}

/**
 * The refresh token — not the access token — is the durable credential. A
 * session that still carries one can be renewed silently, so it must never be
 * routed as signed out.
 */
function isSessionRecoverable(session) {
  return Boolean(
    session &&
      typeof session.refresh_token === 'string' &&
      session.refresh_token.length > 0,
  );
}

/**
 * Usable means "this actor may stay in the app", not "this access token is
 * currently valid". An expired access token on a refreshable session is an
 * ordinary background-and-resume, not a sign-out: Supabase renews it and the
 * server remains the sole authority on whether the credential is still good.
 * Only a session with no refresh material left is genuinely unusable.
 */
function isSessionUsable(session, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!session) return false;
  if (!isAccessTokenExpired(session, nowSeconds)) return true;
  return isSessionRecoverable(session);
}

/**
 * Distinguishes a fully valid session from one whose access token has lapsed
 * and is awaiting silent renewal, so callers can defer writes or show accurate
 * recovery messaging without redirecting the actor to login.
 */
function getSessionAuthState(session, nowSeconds = Math.floor(Date.now() / 1000), options = {}) {
  if (options.loading) return AUTH_STATE.UNKNOWN;
  if (!isSessionUsable(session, nowSeconds)) return AUTH_STATE.UNAUTHENTICATED;
  if (isAccessTokenExpired(session, nowSeconds)) return AUTH_STATE.RECOVERY_PENDING;
  return AUTH_STATE.AUTHENTICATED;
}

function hasPendingDeletionProfile(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return profile.account_status === 'pending_deletion' || Boolean(profile.account_locked_at);
}

function getRoutingGuardState({ pathname, loading, session, nowSeconds, profile, profileLoading, onboardingComplete = null, recoveryPending = false }) {
  const normalizedPathname = normalizePathname(pathname);
  const hasUsableSession = isSessionUsable(session, nowSeconds);

  if (loading) {
    return { action: 'loading', pathname: normalizedPathname, redirectTo: null };
  }

  if (!hasUsableSession) {
    if (isPublicRoute(normalizedPathname)) {
      return { action: 'allow', pathname: normalizedPathname, redirectTo: null };
    }
    // Recoverable session material is still stored: the actor has not signed
    // out, so they are held in a truthful recovery state rather than pushed
    // through a login they do not need.
    if (recoveryPending) {
      return { action: 'recovering', pathname: normalizedPathname, redirectTo: null };
    }
    return { action: 'redirect', pathname: normalizedPathname, redirectTo: '/auth' };
  }

  if (isPasswordRecoveryRoute(normalizedPathname)) {
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

  if (
    isAuthEntryRoute(normalizedPathname) ||
    normalizedPathname === '/auth/callback' ||
    isOnboardingRoute(normalizedPathname)
  ) {
    return { action: 'redirect', pathname: normalizedPathname, redirectTo: '/' };
  }

  return { action: 'allow', pathname: normalizedPathname, redirectTo: null };
}

module.exports = {
  AUTH_STATE,
  LIMITED_ACCOUNT_ROUTES,
  PUBLIC_ROUTES,
  getRoutingGuardState,
  getSessionAuthState,
  isAccessTokenExpired,
  isSessionRecoverable,
  hasPendingDeletionProfile,
  isAuthCallbackUrl,
  isPasswordRecoveryRoute,
  isLimitedAccountRoute,
  isOnboardingRoute,
  isPublicRoute,
  isSessionUsable,
  normalizePathname,
  shouldCommitRouteNavigation,
  shouldPreserveAuthNavigatorDuringLoading,
};
