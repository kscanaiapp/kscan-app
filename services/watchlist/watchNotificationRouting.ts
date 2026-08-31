/**
 * K+ Smart Watchlist V1 — notification tap routing (hostile-audit repair
 * DEF-WL-03).
 *
 * pushDelivery.ts sends `data: { watchId, eventType, deepLink }` and its
 * header states that tapping resolves to `/watchlist/[watchId]`. Nothing in
 * the app read that payload: there was no notification-response listener and
 * no notification handler anywhere in source, so a tapped alert opened the
 * app on its default route and a foreground alert was not presented at all.
 * This module is the missing consumer, and nothing else.
 *
 * SECURITY. The route is derived ONLY from `watchId`, and only when it is a
 * syntactically valid UUID. `deepLink` — the one field in the payload shaped
 * like a URL — is deliberately never read: a push payload is untrusted input,
 * and the app must not be steerable to an arbitrary destination by it. A
 * forged, deleted, or another actor's watch id resolves to the ordinary
 * detail route, where the screen's own RLS-scoped read returns nothing and
 * the screen shows its error state. Ownership is decided by the database
 * under the viewer's session, never by the notification.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The in-app route for a Watchlist notification payload, or null when this
 * notification is not a Watchlist one (or carries no usable watch id).
 */
export function watchRouteFromNotificationData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const watchId = record.watchId;
  if (typeof watchId !== 'string' || !UUID_RE.test(watchId)) return null;
  return `/watchlist/${watchId}`;
}

export interface WatchNotificationRoutingHandle {
  remove: () => void;
}

/**
 * Installs the foreground presentation handler and the tap listener.
 *
 * expo-notifications is imported lazily for the same reason
 * pushRegistration.ts does: its native module should not load for a user who
 * never reaches the contextual alert prompt. Every step is best-effort — a
 * device or build without notification support must never break app startup,
 * so a failure here leaves the app exactly as it was.
 */
export function installWatchNotificationRouting(
  navigate: (route: string) => void,
): WatchNotificationRoutingHandle {
  let disposed = false;
  let subscriptionRemove: (() => void) | null = null;

  void (async () => {
    try {
      const Notifications = await import('expo-notifications');
      if (disposed) return;

      // Without a handler, expo-notifications shows nothing while the app is
      // foregrounded — a price alert that arrives while the user is in the
      // app would be silently dropped.
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
          // Retained for older expo-notifications typings, which still
          // require the pre-banner field names.
          shouldShowAlert: true,
        }),
      });

      // A tap that launched the app from cold start is delivered here rather
      // than through the listener below.
      try {
        const initial = await Notifications.getLastNotificationResponseAsync();
        const initialRoute = watchRouteFromNotificationData(
          initial?.notification?.request?.content?.data,
        );
        if (initialRoute && !disposed) navigate(initialRoute);
      } catch {
        // No launch response available on this platform/build.
      }

      if (disposed) return;
      const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        const route = watchRouteFromNotificationData(response?.notification?.request?.content?.data);
        if (route) navigate(route);
      });
      subscriptionRemove = () => subscription.remove();
    } catch {
      // expo-notifications unavailable (web, a build without the module):
      // Watchlist stays fully usable, taps simply open the app normally.
    }
  })();

  return {
    remove: () => {
      disposed = true;
      subscriptionRemove?.();
      subscriptionRemove = null;
    },
  };
}
