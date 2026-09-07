/**
 * The one JSX file in the PostHog wrapper. Everything else — client
 * construction, sink bridging, identity sync — lives in posthogClient.core.ts
 * (no JSX, so it can be `require()`d directly by tests and verification
 * scripts). This file re-exports all of it plus the single Provider
 * component; nothing outside this pair may import `posthog-react-native`
 * directly.
 */

import React from 'react';

import { posthog, PostHogProvider } from './posthogClient.core';

export * from './posthogClient.core';

/**
 * The sole call site for `PostHogProvider`. A component that needs the
 * client wraps its tree in this, never in `PostHogProvider` directly.
 */
export function PostHogAnalyticsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  if (!posthog) return <>{children}</>;
  return (
    <PostHogProvider client={posthog} autocapture={false}>
      {children}
    </PostHogProvider>
  );
}
