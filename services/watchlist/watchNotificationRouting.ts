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
 *
 * ────────────────────────────────────────────────────────────────────────────
 * N-2 / N-3 — the launch-response lifecycle
 *
 * N-2 (cold-start router readiness). A tap that launches the app from cold is
 * delivered by getLastNotificationResponseAsync() rather than by the listener,
 * and it resolves within the first frames of startup — before the root
 * navigator has mounted. Navigating then is a no-op: expo-router drops the
 * push, so the user lands on the default route and the alert they tapped is
 * silently lost. The fix is not a delay. A route derived from a valid launch
 * response is RETAINED, and navigation happens on the navigator's own
 * readiness signal (app/_layout.tsx subscribes to the root container ref and
 * calls notifyNavigationReady). No timer, no polling, no lost response.
 *
 * N-3 (launch-response replay). The OS keeps returning the same launch
 * response until it is explicitly cleared, so any later re-installation of
 * this handler in the same app lifetime — a Fast Refresh, a StrictMode double
 * mount, a remount of the root layout — read it again and navigated again.
 * Once a response has been acted on it is cleared through expo-notifications'
 * own API, and a module-scoped consumed flag independently blocks a re-read
 * even if that clear fails or is unavailable on the platform.
 *
 * WHY MODULE SCOPE. This state deliberately outlives any single install: the
 * defect being closed IS re-installation, so per-handle state could not see
 * it. It is in-memory only and lives exactly one app launch — nothing here is
 * persisted to storage, and no notification identifier is retained.
 *
 * ORDERING. Every accepted response follows one path — accept into the pending
 * slot, clear the OS-held response, then navigate if the navigator is ready.
 * Clearing before navigating is what makes a remount mid-navigation unable to
 * replay, and holding the route in the pending slot rather than navigating
 * eagerly is what makes a not-yet-ready navigator unable to lose it.
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
  /**
   * N-2. Called by the root layout once the root navigator is mounted and can
   * accept navigation. Idempotent: the layout fires it on every navigation
   * state change, and every call after the first flush is a no-op.
   */
  notifyNavigationReady: () => void;
}

type ExpoNotificationsModule = typeof import('expo-notifications');

// ── launch lifecycle state (in memory, one app launch — see WHY MODULE SCOPE) ─

/** True once the root navigator has reported itself ready at least once. */
let navigationReady = false;

/**
 * The single retained route awaiting a ready navigator.
 *
 * Deliberately ONE slot rather than a queue: a queue would replay every alert
 * the user ever tapped as a burst of navigations, and only the newest tap
 * describes where the user actually asked to go.
 */
let pendingRoute: string | null = null;

/**
 * N-3. True once a notification response has been acted on in this app
 * lifetime. Independent of the OS-level clear below, so a platform that does
 * not implement clearing — or a clear that throws — still cannot replay.
 */
let lastResponseConsumed = false;

/** The navigate callback of the currently installed handle, if any. */
let activeNavigate: ((route: string) => void) | null = null;

/**
 * Navigates the retained route, if there is one and the navigator can take it.
 *
 * The slot is emptied BEFORE navigating, so a re-entrant call — the layout
 * firing readiness again while this navigation is still settling — finds
 * nothing left to repeat. This is the only place navigation happens.
 */
function flushPendingRoute(): void {
  if (!navigationReady) return;
  const navigate = activeNavigate;
  const route = pendingRoute;
  if (!navigate || !route) return;
  pendingRoute = null;
  navigate(route);
}

/**
 * N-3. Drops the OS-held launch response so it cannot be read again.
 *
 * expo-notifications documents this for exactly this case: "May be used when
 * an app selects a route based on the notification response, and it is
 * undesirable to continue selecting the route after the response has already
 * been handled." The synchronous form is current; the async form is the
 * deprecated spelling, kept as a fallback so an SDK that only ships the older
 * name still clears. Entirely best-effort: `lastResponseConsumed` is the
 * authority that must not fail, and a clear that throws or is missing must
 * never break startup or spin a retry.
 */
function clearHandledResponse(Notifications: ExpoNotificationsModule): void {
  try {
    if (typeof Notifications.clearLastNotificationResponse === 'function') {
      Notifications.clearLastNotificationResponse();
      return;
    }
    if (typeof Notifications.clearLastNotificationResponseAsync === 'function') {
      void Promise.resolve(Notifications.clearLastNotificationResponseAsync()).catch(() => {});
    }
  } catch {
    // Best effort by design — see above.
  }
}

/**
 * THE one path every notification response takes, cold or warm.
 *
 * Accept, then clear, then navigate — never navigate before clearing (a
 * remount mid-navigation would replay) and never navigate before the
 * navigator is ready (the route would be dropped). `route` is null for a
 * notification that is not a Watchlist one: it is still consumed and cleared,
 * because we have decided about it, but it contributes no destination.
 */
function acceptResponseRoute(
  route: string | null,
  Notifications: ExpoNotificationsModule,
): void {
  lastResponseConsumed = true;
  // Newest tap wins: a warm tap arriving while a cold-start route is still
  // pending replaces it, so exactly one navigation happens and it is the one
  // the user asked for most recently.
  if (route) pendingRoute = route;
  clearHandledResponse(Notifications);
  flushPendingRoute();
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

  // Adopt this install's navigate immediately, so a route retained by an
  // earlier install that was torn down before the navigator was ready is
  // delivered through the handle that is actually live now.
  activeNavigate = navigate;

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
      //
      // N-3: skipped outright once any response has been consumed in this app
      // lifetime, so a re-installed handler cannot re-read and re-navigate an
      // already-handled launch. Deliberately NOT gated on `disposed`: a route
      // read by an install that is being torn down is still a real tap, and
      // dropping it is the lost-response half of N-2. It is retained instead,
      // and the next install delivers it.
      if (!lastResponseConsumed) {
        try {
          const initial = await Notifications.getLastNotificationResponseAsync();
          if (initial) {
            acceptResponseRoute(
              watchRouteFromNotificationData(initial?.notification?.request?.content?.data),
              Notifications,
            );
          }
        } catch {
          // No launch response available on this platform/build.
        }
      }

      if (disposed) return;
      const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        acceptResponseRoute(
          watchRouteFromNotificationData(response?.notification?.request?.content?.data),
          Notifications,
        );
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
      // Only disown the callback if it is still ours: a newer install may
      // already have taken over, and stealing its callback would strand a
      // retained route with nothing to deliver it.
      if (activeNavigate === navigate) activeNavigate = null;
    },
    notifyNavigationReady: () => {
      navigationReady = true;
      flushPendingRoute();
    },
  };
}
