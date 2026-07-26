/**
 * Shared Expo Router exit helpers.
 *
 * Prefer Back when the stack has history; otherwise replace to a known
 * in-app destination so direct entry / restored routes cannot trap users.
 */

export const CANONICAL_HOME_ROUTE = '/' as const;
export const CANONICAL_ONBOARDING_ROUTE = '/onboarding' as const;
export const CANONICAL_AUTH_ROUTE = '/auth' as const;

export type NavigationExitRouter = {
  canGoBack: () => boolean;
  back: () => void;
  // Expo Router's replace accepts a typed Href; callers pass string route literals.
  replace: (href: any) => void;
};

export function goBackOrReplace(
  router: NavigationExitRouter,
  fallbackRoute: string,
): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(fallbackRoute);
}

/** Authenticated stack screens → Home when history is empty. */
export function goBackOrHome(router: NavigationExitRouter): void {
  goBackOrReplace(router, CANONICAL_HOME_ROUTE);
}

/** Public auth funnel → onboarding when history is empty. */
export function goBackOrOnboarding(router: NavigationExitRouter): void {
  goBackOrReplace(router, CANONICAL_ONBOARDING_ROUTE);
}

/** Nested auth screens → sign-in when history is empty. */
export function goBackOrAuth(router: NavigationExitRouter): void {
  goBackOrReplace(router, CANONICAL_AUTH_ROUTE);
}
