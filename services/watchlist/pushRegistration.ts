/**
 * K5-C6: notification permission + device registration.
 *
 * Deliberately never called on app launch, K+ activation, or Watchlist
 * open. The only caller is the post-Watch-creation "alert me?" prompt
 * (services/watchlist/watchlistClient.ts consumers) — see the master build
 * brief §51-52. A denied permission leaves the Watch valid with
 * push_enabled left false; this module never blocks Watch creation.
 */
import { Platform, Linking } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabaseClient';
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';

const DEVICE_ID_STORAGE_KEY = 'kscan-watchlist-device-id';

/** Product notification channel id (Android 8+). Used for every Watch alert send. */
export const ANDROID_NOTIFICATION_CHANNEL_ID = 'price-alerts';

/**
 * NOTIF-14: the Expo project id is read explicitly from the resolved Expo
 * config rather than left to implicit discovery, which silently fails in
 * bare/EAS builds and yields no token. Never hard-codes a second identifier:
 * if this is missing the caller must treat push as unavailable.
 */
export function getExplicitEasProjectId(): string | null {
  const fromExtra = Constants.expoConfig?.extra?.eas?.projectId;
  const fromEasConfig = (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig
    ?.projectId;
  const projectId = fromExtra ?? fromEasConfig ?? null;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : null;
}

/**
 * NOTIF-07: product-specific Android channel. Created before the first token
 * is requested so the very first delivered alert already lands on the right
 * channel with the intended importance/sound/vibration/badge policy.
 */
export async function configureAndroidNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const Notifications = await import('expo-notifications');
  await Notifications.setNotificationChannelAsync(ANDROID_NOTIFICATION_CHANNEL_ID, {
    name: 'Price Alerts',
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
    showBadge: true,
  });
}

/** NOTIF-11: recovery route when permission can no longer be requested. */
export function openNotificationSettings(): Promise<void> {
  return Linking.openSettings();
}

/** Current OS notification permission state, for reflecting real UI state. */
export async function getNotificationPermissionStatus() {
  const Notifications = await import('expo-notifications');
  return Notifications.getPermissionsAsync();
}

/** The stored id for this installation, or null if this device never registered. */
async function readDeviceId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function getOrCreateDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

export type RequestWatchAlertsResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported_platform' | 'permission_denied' | 'token_failed' | 'register_failed' | 'request_failed' };

/**
 * Requests OS notification permission (if not already decided), fetches an
 * Expo push token, registers the device, and marks the given Watch as
 * push_enabled. Every step is best-effort past permission: a token or
 * registration failure leaves the Watch exactly as it was (push_enabled
 * stays false), never as a broken intermediate state.
 */
export async function requestWatchAlerts(watchId: string): Promise<RequestWatchAlertsResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { ok: false, reason: 'unsupported_platform' };
  }

  // Lazy import: expo-notifications pulls in native modules that should
  // never load for a user who never reaches this contextual prompt.
  const Notifications = await import('expo-notifications');

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted && existing.canAskAgain) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted;
  }
  if (!granted) {
    return { ok: false, reason: 'permission_denied' };
  }

  if (Platform.OS === 'android') {
    try {
      await configureAndroidNotificationChannel();
    } catch {
      // Presentation quality only; never blocks a granted permission.
    }
  }

  const projectId = getExplicitEasProjectId();
  if (!projectId) {
    return { ok: false, reason: 'token_failed' };
  }

  let expoPushToken: string;
  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    expoPushToken = tokenResponse.data;
  } catch {
    return { ok: false, reason: 'token_failed' };
  }
  if (!expoPushToken) {
    return { ok: false, reason: 'token_failed' };
  }

  const deviceId = await getOrCreateDeviceId();

  const session = await resolveAuthenticatedFunctionSession();
  if (session.ok === false) {
    return { ok: false, reason: 'request_failed' };
  }

  const registerResult = await supabase.functions.invoke('commerce-watch-refresh', {
    body: {
      action: 'register_push_token',
      pushToken: expoPushToken,
      platform: Platform.OS,
      deviceId,
    },
  });
  if (registerResult.error) {
    return { ok: false, reason: 'register_failed' };
  }

  const enableResult = await supabase.functions.invoke('commerce-watch-refresh', {
    body: { action: 'set_push_enabled', watchId, enabled: true },
  });
  if (enableResult.error) {
    return { ok: false, reason: 'register_failed' };
  }

  return { ok: true };
}

/**
 * SEC-KPLUS-001 (hostile-audit repair): asserts that THIS device now belongs to
 * the actor who just arrived, retiring every other actor's live push route on it.
 *
 * This is the half DEF-WL-01 could not reach. That repair retires a stale route
 * as a side effect of REGISTERING, so it only fires if the new owner of the
 * handset enables Watch alerts. Alerts are a contextual post-Watch-creation
 * prompt, not onboarding — most arriving actors never register at all, and the
 * departed actor's route stayed live and deliverable, carrying their watched
 * item's title and price to a handset that is no longer theirs.
 *
 * Called on sign-IN rather than sign-out precisely because the departing side is
 * the unreliable one: a force-quit, crash, reinstall, cleared storage or expired
 * session all skip revokeWatchAlertsForThisDevice entirely. Arrival is
 * observable; departure is not.
 *
 * Requires no notification permission, mints no device id, and registers
 * nothing. Never throws and never blocks sign-in.
 */
export async function claimDeviceForCurrentActor(): Promise<void> {
  try {
    // Deliberately does NOT mint an id: a device that never registered for
    // alerts has no route to retire.
    const deviceId = await readDeviceId();
    if (!deviceId) return;
    const session = await resolveAuthenticatedFunctionSession();
    if (session.ok === false) return;
    await supabase.functions.invoke('commerce-watch-refresh', {
      body: { action: 'claim_device', deviceId },
    });
  } catch {
    // Silent: a failed claim must never fail or delay a sign-in. The server
    // still retires the foreign route the moment this actor registers.
  }
}

/**
 * DEF-WL-01 (hostile-audit repair): retires THIS device's push registration
 * for the actor who is leaving.
 *
 * Called on the actor boundary (sign-out) BEFORE the Supabase session is
 * destroyed, because the revocation is an authenticated call. Without it a
 * departed actor's row stays deliverable and their Watch alerts — whose
 * notification body carries the watched item's title and price — keep landing
 * on a handset that now belongs to someone else. The server holds the same
 * invariant independently (register_device_push_token retires any other live
 * row for this device or token, and a partial unique index makes two live
 * rows per token unrepresentable), so this is the cooperative half, not the
 * only guard.
 *
 * Never throws and never blocks: sign-out must complete even if the network,
 * the session, or storage is unavailable. Does nothing at all when this
 * device never registered — it deliberately does not mint a device id.
 */
export async function revokeWatchAlertsForThisDevice(): Promise<void> {
  try {
    const deviceId = await readDeviceId();
    if (!deviceId) return;
    const session = await resolveAuthenticatedFunctionSession();
    if (session.ok === false) return;
    await supabase.functions.invoke('commerce-watch-refresh', {
      body: { action: 'revoke_push_token', deviceId },
    });
  } catch {
    // Intentionally silent: a failed revocation must never fail a sign-out.
    // The server-side invariant still retires this row the moment the next
    // actor registers on this device.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Device-level notification enablement (onboarding Permissions surface).
//
// Deliberately SEPARATE from requestWatchAlerts: enabling notifications for
// the device must never enable any individual Watch's alert. Device push
// registration and per-Watch alert preference remain distinct concepts.
// ─────────────────────────────────────────────────────────────────────────────

export type EnableDeviceNotificationsFailureReason =
  | 'unsupported_platform'
  | 'permission_denied'
  | 'missing_project_id'
  | 'token_failed'
  | 'backend_unavailable';

/**
 * Flat by design (not a discriminated union): `reason` is simply undefined on
 * success. Callers check `ok` first.
 */
export interface EnableDeviceNotificationsResult {
  ok: boolean;
  reason?: EnableDeviceNotificationsFailureReason;
  canAskAgain: boolean;
}

/**
 * Requests the real OS notification permission, acquires an Expo push token
 * with the explicit project id, and registers THIS device for the
 * authenticated actor. Enables no Watch alert.
 *
 * Every failure mode is distinguishable so the caller can render an honest
 * state — denied vs. temporarily unavailable — and never a false "enabled".
 */
export async function enableDeviceNotifications(): Promise<EnableDeviceNotificationsResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { ok: false, reason: 'unsupported_platform', canAskAgain: false };
  }

  const Notifications = await import('expo-notifications');

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  let canAskAgain = existing.canAskAgain;
  if (!granted && existing.canAskAgain) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted;
    canAskAgain = requested.canAskAgain;
  }
  if (!granted) {
    return { ok: false, reason: 'permission_denied', canAskAgain };
  }

  if (Platform.OS === 'android') {
    try {
      await configureAndroidNotificationChannel();
    } catch {
      // Presentation only; a granted permission still stands.
    }
  }

  const projectId = getExplicitEasProjectId();
  if (!projectId) {
    return { ok: false, reason: 'missing_project_id', canAskAgain: true };
  }

  let expoPushToken: string;
  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    expoPushToken = tokenResponse.data;
  } catch {
    return { ok: false, reason: 'token_failed', canAskAgain: true };
  }
  if (!expoPushToken) {
    return { ok: false, reason: 'token_failed', canAskAgain: true };
  }

  const deviceId = await getOrCreateDeviceId();

  const session = await resolveAuthenticatedFunctionSession();
  if (session.ok === false) {
    return { ok: false, reason: 'backend_unavailable', canAskAgain: true };
  }

  try {
    const registerResult = await supabase.functions.invoke('commerce-watch-refresh', {
      body: {
        action: 'register_push_token',
        pushToken: expoPushToken,
        platform: Platform.OS,
        deviceId,
      },
    });
    if (registerResult.error) {
      return { ok: false, reason: 'backend_unavailable', canAskAgain: true };
    }
  } catch {
    return { ok: false, reason: 'backend_unavailable', canAskAgain: true };
  }

  return { ok: true, canAskAgain: true };
}

/**
 * Token-refresh lifecycle. The push service can roll the underlying device
 * token while the app runs; the old one stops delivering. Re-registers the
 * new Expo token for a device that already opted in. A device that never
 * registered mints nothing.
 */
export async function attachPushTokenRefreshListener(): Promise<() => void> {
  const Notifications = await import('expo-notifications');
  const subscription = Notifications.addPushTokenListener(() => {
    void (async () => {
      const deviceId = await readDeviceId();
      if (!deviceId) return;
      const projectId = getExplicitEasProjectId();
      if (!projectId) return;
      try {
        const session = await resolveAuthenticatedFunctionSession();
        if (session.ok === false) return;
        const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
        await supabase.functions.invoke('commerce-watch-refresh', {
          body: {
            action: 'register_push_token',
            pushToken: tokenResponse.data,
            platform: Platform.OS,
            deviceId,
          },
        });
      } catch {
        // Best effort. The next send's DeviceNotRegistered receipt retires
        // the stale route server-side regardless.
      }
    })();
  });
  return () => subscription.remove();
}

/**
 * NOTIF-15 foreground receive. Fires while the app is open. Never navigates
 * — only a tap may route (see watchNotificationRouting) — so this cannot
 * duplicate navigation with the response listener.
 */
export async function attachNotificationReceivedListener(
  onReceived: (data: unknown) => void,
): Promise<() => void> {
  const Notifications = await import('expo-notifications');
  const subscription = Notifications.addNotificationReceivedListener((event) => {
    onReceived(event.request.content.data);
  });
  return () => subscription.remove();
}
