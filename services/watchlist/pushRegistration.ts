/**
 * K5-C6: notification permission + device registration.
 *
 * Deliberately never called on app launch, K+ activation, or Watchlist
 * open. The only caller is the post-Watch-creation "alert me?" prompt
 * (services/watchlist/watchlistClient.ts consumers) — see the master build
 * brief §51-52. A denied permission leaves the Watch valid with
 * push_enabled left false; this module never blocks Watch creation.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabaseClient';
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';

const DEVICE_ID_STORAGE_KEY = 'kscan-watchlist-device-id';

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

  let expoPushToken: string;
  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync();
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
