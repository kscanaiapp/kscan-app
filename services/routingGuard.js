const ACCOUNT_RESTORE_ROUTE = '/account/restore';

const PUBLIC_ROUTES = new Set([
  '/auth',
  '/auth/callback',
  '/auth/reset',
  '/auth/update-password',
  '/onboarding',
  // Account restoration is reached from an emailed link by a user who cannot
  // sign in (their account is in the `deactivated` grace window). The token in
  // the URL is validated server-side by restore-account, exactly like the
  // shared-room token below.
  '/account/restore',
]);

// Routes a limited account (pending_deletion / locked) may still use.
// `/account/restore` is here as well as in PUBLIC_ROUTES because a deactivated
// user may still hold a live session: without it the pending-deletion redirect
// below would bounce them to /privacy and their restoration link would be
// unusable for the one case it exists to serve.
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

/**
 * The account restoration route, specifically.
 *
 * Deliberately NOT `isLimitedAccountRoute`, which also covers `/privacy`:
 * exempting restoration from the onboarding redirect must not incidentally
 * make the privacy screen reachable mid-onboarding.
 */
function isAccountRestoreRoute(pathname) {
  return normalizePathname(pathname) === ACCOUNT_RESTORE_ROUTE;
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
    // KSB29-059. Account restoration was exempted from the signed-out branch
    // (PUBLIC_ROUTES) and from the pending-deletion branch
    // (LIMITED_ACCOUNT_ROUTES), but NOT from this one. A user with a live
    // session and incomplete onboarding who opened their emailed restoration
    // link was redirected to /onboarding while the restore screen had already
    // mounted and consumed the token -- a single-use token spent on a screen
    // that was replaced before it could show the result, turning a recoverable
    // account into a user-facing dead end.
    //
    // Restoration is a recovery route, like password recovery above it, and
    // must be allowed to complete before ordinary onboarding routing applies.
    //
    // Deliberately isAccountRestoreRoute and NOT isLimitedAccountRoute: the
    // latter also covers /privacy, and exempting restoration must not
    // incidentally make the privacy screen reachable mid-onboarding.
    if (isAccountRestoreRoute(normalizedPathname)) {
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
  ACCOUNT_RESTORE_ROUTE,
  LIMITED_ACCOUNT_ROUTES,
  PUBLIC_ROUTES,
  getRoutingGuardState,
  hasPendingDeletionProfile,
  isAccountRestoreRoute,
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
