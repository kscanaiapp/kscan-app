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

/**
 * RP-104. Records that the user explicitly turned K Scan AI Notifications OFF on
 * THIS device.
 *
 * Deliberately a SEPARATE key from the device id: the device identity must
 * survive an OFF (deleting it would mint a second identity on the next ON and
 * strand the revoked row), so "is this device disabled?" cannot be inferred
 * from the id's absence.
 *
 * This is not a preference backend and is not the authority on delivery -- the
 * backend `user_device_push_tokens` row is. It exists for exactly one job: to
 * stop the AUTOMATIC re-registration paths (push-token refresh) from silently
 * rebuilding a route the user explicitly revoked.
 */
const DEVICE_PUSH_DISABLED_STORAGE_KEY = 'kscan-watchlist-device-push-disabled';

/**
 * RP-104 in-process disable generation. Incremented synchronously by every
 * explicit disable, captured by every enable.
 *
 * The persisted marker above cannot settle an ON and an OFF that overlap in
 * memory: both read storage before either writes it. This counter can, because
 * the increment happens before the disable's first await, so an enable that
 * started earlier sees a changed generation and refuses to register rather
 * than re-arming a route the user just revoked.
 */
let devicePushDisableGeneration = 0;

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

/**
 * RP-104. True only when the user explicitly turned K Scan AI Notifications OFF
 * on this device and has not turned them back on.
 *
 * Fails OPEN (returns false) on a storage fault: an unreadable marker must not
 * silently suppress a route the user asked for. The backend row remains the
 * authority on whether anything is actually deliverable.
 */
async function isDevicePushExplicitlyDisabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DEVICE_PUSH_DISABLED_STORAGE_KEY)) === 'true';
  } catch {
    return false;
  }
}

/** Records the explicit OFF. Storage faults are swallowed: see below. */
async function markDevicePushExplicitlyDisabled(): Promise<void> {
  try {
    await AsyncStorage.setItem(DEVICE_PUSH_DISABLED_STORAGE_KEY, 'true');
  } catch {
    // The backend revocation is the material authority for delivery; this
    // marker only suppresses automatic re-registration. A storage fault must
    // not stop the revocation itself from being attempted.
  }
}

/** Clears the OFF marker. Called only where the user explicitly re-arms. */
async function clearDevicePushExplicitlyDisabled(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DEVICE_PUSH_DISABLED_STORAGE_KEY);
  } catch {
    // Same rationale as above.
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

  // RP-104: this device now has a live route again, so the explicit-OFF marker
  // is stale and must stop suppressing token-refresh re-registration.
  //
  // Not a hole in the OFF invariant: reaching here required the user to tap
  // "alert me" on a Watch and grant permission. That is a fresh, explicit
  // opt-in to delivery on this handset, exactly like tapping the onboarding
  // switch back on — not an automatic path.
  await clearDevicePushExplicitlyDisabled();

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
  | 'backend_unavailable'
  /**
   * RP-104: an explicit OFF was issued while this enable was still in flight.
   * The registration is abandoned rather than completed, so a stale ON can
   * never re-arm a route the user has since revoked.
   */
  | 'superseded';

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
  // RP-104: captured BEFORE the first await. Any explicit disable that starts
  // after this line changes the generation, and the check below abandons this
  // registration instead of re-arming the route the user just turned off.
  const generation = devicePushDisableGeneration;

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

  // RP-104: last gate before the route is actually armed.
  if (generation !== devicePushDisableGeneration) {
    return { ok: false, reason: 'superseded', canAskAgain: true };
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

  // RP-104: the route is live again, so the explicit-OFF marker no longer
  // describes this device and must stop suppressing token-refresh
  // re-registration. Cleared only AFTER a registration that actually
  // succeeded, and only on the path the user explicitly asked for.
  await clearDevicePushExplicitlyDisabled();

  return { ok: true, canAskAgain: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// RP-104: the canonical device-level DISABLE.
// ─────────────────────────────────────────────────────────────────────────────

export type DisableDeviceNotificationsFailureReason = 'backend_unavailable';

/**
 * Mirrors EnableDeviceNotificationsResult's flat shape on purpose, so the
 * onboarding surface handles both directions of the same switch identically.
 */
export interface DisableDeviceNotificationsResult {
  ok: boolean;
  reason?: DisableDeviceNotificationsFailureReason;
  /**
   * True when this install had no registered device identifier at all, so
   * there was no K Scan AI push-delivery route to revoke. Still `ok: true`: OFF
   * is already the truth for delivery.
   */
  alreadyUnregistered?: boolean;
}

/**
 * RP-104. Turns K Scan AI Notifications OFF for THIS device by revoking its
 * backend push-delivery route.
 *
 * The defect this closes: turning the onboarding switch off only flipped local
 * UI state. The `user_device_push_tokens` row stayed live, so the UI said OFF
 * while the backend could still deliver K Scan AI pushes to the handset — a false
 * control over a real delivery channel.
 *
 * Scope, precisely:
 *  - Revokes THIS device only. `revoke_device_push_token` is keyed on
 *    (user_id, device_id), so the same actor's other handsets are untouched.
 *  - Deletes NO Watchlist record, price target, stock target or saved Watch,
 *    and touches no K+ entitlement. Turning delivery off is not withdrawing
 *    monitoring intent; a later ON re-registers through the canonical
 *    enableDeviceNotifications() path.
 *  - Changes NO operating-system notification authorization. It cannot, and it
 *    never claims to: iOS/Android authorization is only revocable by the user
 *    in Settings. This owns the application-level delivery route.
 *  - Requests NO permission and mints NO device identifier. An install that
 *    never registered is already OFF for delivery; minting an id to disable
 *    something would create the very registration being disabled.
 *
 * Returns a bounded typed result. No backend body, status or error text ever
 * reaches the caller.
 */
export async function disableDeviceNotifications(): Promise<DisableDeviceNotificationsResult> {
  // Synchronous and first: an enable already in flight must observe this
  // before it reaches its own registration gate.
  devicePushDisableGeneration += 1;

  const deviceId = await readDeviceId();
  if (!deviceId) {
    // No identifier means no route. Record the explicit intent and stop —
    // no minted id, no token, no permission prompt, no backend call.
    await markDevicePushExplicitlyDisabled();
    return { ok: true, alreadyUnregistered: true };
  }

  // Marked BEFORE the network call, so a push-token refresh that fires while
  // the revocation is in flight cannot re-register underneath it. Restored on
  // failure below, so the marker never outlives a revocation that did not
  // actually happen.
  await markDevicePushExplicitlyDisabled();

  const session = await resolveAuthenticatedFunctionSession();
  if (session.ok === false) {
    await clearDevicePushExplicitlyDisabled();
    return { ok: false, reason: 'backend_unavailable' };
  }

  try {
    const result = await supabase.functions.invoke('commerce-watch-refresh', {
      body: { action: 'revoke_push_token', deviceId },
    });
    if (result.error) {
      await clearDevicePushExplicitlyDisabled();
      return { ok: false, reason: 'backend_unavailable' };
    }
  } catch {
    await clearDevicePushExplicitlyDisabled();
    return { ok: false, reason: 'backend_unavailable' };
  }

  return { ok: true };
}

/**
 * Token-refresh lifecycle. The push service can roll the underlying device
 * token while the app runs; the old one stops delivering. Re-registers the
 * new Expo token for a device that already opted in. A device that never
 * registered mints nothing.
 *
 * RP-104: this listener is installed for the whole app lifetime at the root
 * (app/_layout.tsx), and it re-registers on an event the user neither sees nor
 * triggers. That made it the one path that could silently defeat an explicit
 * OFF: the device id survives a disable by design, so before this repair a
 * token roll rebuilt the very route the user had just revoked, with no UI
 * anywhere reflecting it. It now refuses to register while the explicit-OFF
 * marker stands, and only the user turning Notifications back on clears it.
 */
export async function attachPushTokenRefreshListener(): Promise<() => void> {
  const Notifications = await import('expo-notifications');
  const subscription = Notifications.addPushTokenListener(() => {
    void (async () => {
      const deviceId = await readDeviceId();
      if (!deviceId) return;
      // RP-104: an automatic refresh may never re-arm a route the user
      // explicitly turned off. Checked before any network work.
      if (await isDevicePushExplicitlyDisabled()) return;
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
