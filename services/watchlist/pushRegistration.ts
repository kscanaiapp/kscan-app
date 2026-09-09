/**
 * K5-C6: notification permission + device registration.
 *
 * Deliberately never called on app launch, K+ activation, or Watchlist
 * open. The only caller is the post-Watch-creation "alert me?" prompt
 * (services/watchlist/watchlistClient.ts consumers) — see the master build
 * brief §51-52. A denied permission leaves the Watch valid with
 * push_enabled left false; this module never blocks Watch creation.
 *
 * Android Repair 05: every ACTIVATION path here (permission request, token
 * acquisition, token-refresh re-registration) is additionally gated by the one
 * canonical decision in services/notifications/remotePushCapability.ts. The
 * DEACTIVATION paths -- revocation, explicit disable, actor claim -- are
 * deliberately NOT gated: a route that already exists must always be
 * retireable, whatever this build ships.
 */
import { Platform, Linking } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabaseClient';
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';
import { resolveRemotePushActivationAllowed } from '../notifications/remotePushCapability';
import { currentActorId } from '../actorScope';

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
 * N-6. Which actor THIS device's K Scan push-delivery route currently belongs
 * to, if any.
 *
 * WHY THIS EXISTS. Before N-6 the only durable local facts were "this device
 * has an id" and "the user explicitly turned notifications off". Neither is
 * actor-scoped, and the device id deliberately SURVIVES every revocation
 * (RP-104: deleting it would mint a second identity and strand the revoked
 * row). So there was no local signal that could answer the one question a
 * post-onboarding Settings control must answer truthfully:
 *
 *     does K Scan currently have a delivery route on this device
 *     FOR THE ACTOR WHO IS LOOKING AT THIS SCREEN?
 *
 * Without it, a Settings toggle hydrated from "device id present" would read ON
 * for an actor who has no route at all -- after a sign-out (RP-109 revoked it),
 * after an account switch (claim_device retired it), or on a fresh actor who
 * simply never opted in. That is the same class of defect RP-104 closed from
 * the other direction: a control making a claim about a real delivery channel
 * that the channel does not support.
 *
 * The vocabulary is deliberately three-valued:
 *   - an actor id  -> this device's route belongs to that actor
 *   - '' (empty)   -> this device holds NO route for anyone; established, not guessed
 *   - absent       -> unknown. An install that registered before this repair.
 *                     Treated permissively, exactly as the pre-N-6 code did,
 *                     and backfilled on the next actor claim.
 *
 * It is NOT the delivery authority -- the backend `user_device_push_tokens`
 * row still is. It is the local record of what this device last established
 * with that authority, so the UI can be honest instead of optimistic.
 */
const DEVICE_PUSH_OWNER_STORAGE_KEY = 'kscan-watchlist-device-push-owner';

/** The explicit "no route on this device" value. Distinct from an absent key. */
const NO_DEVICE_PUSH_OWNER = '';

/** Absent/unreadable both read as null: unknown, never as "no owner". */
async function readDevicePushOwner(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(DEVICE_PUSH_OWNER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Records the owner. A null actor id removes the record rather than writing the
 * "no owner" sentinel: an unattributable registration is unknown, and claiming
 * "no route" over a route that was just armed would be the false-OFF this
 * repair exists to prevent.
 */
async function writeDevicePushOwner(actorId: string | null): Promise<void> {
  try {
    if (actorId === null) {
      await AsyncStorage.removeItem(DEVICE_PUSH_OWNER_STORAGE_KEY);
      return;
    }
    await AsyncStorage.setItem(DEVICE_PUSH_OWNER_STORAGE_KEY, actorId);
  } catch {
    // Same rationale as the OFF marker: the backend row is the material
    // authority, and a storage fault must never abort the registration or
    // revocation that is actually being performed.
  }
}

/** Called after a registration that actually succeeded. */
async function recordDevicePushOwnerForCurrentActor(): Promise<void> {
  await writeDevicePushOwner(currentActorId());
}

/**
 * Compare-and-clear. Only ever removes a claim that still names `actorId`.
 *
 * RP-109 depends on this: a sign-out revocation whose completion lands after
 * the NEXT actor has signed in (and possibly registered) must mutate nothing
 * of theirs. Naming the departing actor makes that structurally impossible
 * rather than merely unlikely.
 */
async function releaseDevicePushOwnerIfHeldBy(actorId: string | null): Promise<void> {
  if (actorId === null) return;
  const owner = await readDevicePushOwner();
  if (owner !== actorId) return;
  await writeDevicePushOwner(NO_DEVICE_PUSH_OWNER);
}

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

/**
 * N-6. The operating system's notification authorization for K Scan, reduced to
 * a bounded vocabulary the UI can render without lying.
 *
 * READ-ONLY. Calls `getPermissionsAsync` and nothing else: it never prompts,
 * never acquires a token, never registers, and never opens Settings. That is
 * what makes it safe to run on Settings mount and on every foreground resume.
 *
 * The three states are deliberately derived from `granted`/`canAskAgain`
 * rather than from the platform-specific `status`, because that pair means the
 * same thing on both platforms:
 *
 *   granted                        -> the system permits delivery
 *   !granted && canAskAgain        -> undecided; an explicit ON may still ask
 *   !granted && !canAskAgain       -> only the user can change this, in Settings
 *
 * On iOS `granted` covers authorized, provisional and ephemeral alike -- all
 * three permit delivery, which is the only claim this state makes. On Android
 * 13+ it is the POST_NOTIFICATIONS runtime grant; on older Android, where no
 * runtime permission exists, it reflects whether the user has switched K Scan's
 * notifications off in system settings, with `canAskAgain` false because there
 * is no prompt to show. One shared implementation, one user-visible meaning.
 */
export type DeviceOsNotificationPermission = 'granted' | 'undetermined' | 'blocked' | 'unknown';

export async function readOsNotificationPermission(): Promise<DeviceOsNotificationPermission> {
  try {
    const Notifications = await import('expo-notifications');
    const status = await Notifications.getPermissionsAsync();
    if (status.granted) return 'granted';
    return status.canAskAgain ? 'undetermined' : 'blocked';
  } catch {
    // "We could not read it" is its own answer. Never collapsed into `granted`
    // or `blocked`, both of which would be a claim we cannot support.
    return 'unknown';
  }
}

/**
 * N-6. What K Scan's own delivery route on THIS device is, for THIS actor.
 *
 * READ-ONLY and side-effect free by construction: three AsyncStorage reads and
 * one synchronous actor lookup. It mints no device id, requests no permission,
 * acquires no token and issues no backend call, so a Settings screen may call
 * it on mount and on every resume.
 *
 * Precedence, and why:
 *  1. an explicit OFF wins over everything -- it is the user's own decision and
 *     the thing that suppresses automatic re-registration;
 *  2. no device id at all means nothing was ever registered here;
 *  3. otherwise the owner record decides, with an absent record (a pre-N-6
 *     install) resolving the way the pre-N-6 code already behaved.
 *
 * `unknown` is returned only when local state genuinely could not be read. It
 * is not folded into 'enabled' or 'disabled': presenting either as a fact we do
 * not have is exactly the false claim this lane exists to remove.
 */
export type DeviceNotificationDeliveryState =
  | 'enabled'
  | 'disabled'
  | 'not_registered'
  | 'unknown';

export async function readDeviceNotificationDeliveryState(): Promise<DeviceNotificationDeliveryState> {
  let disabledMarker: string | null;
  let deviceId: string | null;
  let owner: string | null;
  try {
    disabledMarker = await AsyncStorage.getItem(DEVICE_PUSH_DISABLED_STORAGE_KEY);
    deviceId = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
    owner = await AsyncStorage.getItem(DEVICE_PUSH_OWNER_STORAGE_KEY);
  } catch {
    return 'unknown';
  }

  if (disabledMarker === 'true') return 'disabled';
  if (!deviceId) return 'not_registered';
  // Absent owner record: a device that registered before N-6. The only local
  // fact available is the one the pre-N-6 code used, so it is used here too and
  // corrected by the next actor claim.
  if (owner === null) return 'enabled';
  if (owner === NO_DEVICE_PUSH_OWNER) return 'not_registered';
  return owner === currentActorId() ? 'enabled' : 'not_registered';
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
 * N-6. The same read, but with the storage fault kept DISTINGUISHABLE from a
 * genuine absence.
 *
 * `readDeviceId` collapses both into null, which is the right answer for its
 * best-effort callers -- a claim or a logout revocation that cannot read the id
 * simply does nothing. It is the wrong answer for an explicit OFF: "no id"
 * makes disableDeviceNotifications report `ok: true, alreadyUnregistered: true`,
 * a CONFIRMED off, when in truth this device's backend route may still be live
 * and deliverable and we merely failed to read a key. That is the false OFF
 * RP-104 exists to prevent, reached through a different door.
 */
async function readDeviceIdWithFault(): Promise<
  { ok: true; deviceId: string | null } | { ok: false }
> {
  try {
    return { ok: true, deviceId: await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY) };
  } catch {
    return { ok: false };
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

/**
 * RP-109. Resolves with `onDeadline` if `operation` has not settled in
 * `timeoutMs`, and always clears its own timer.
 *
 * Mirrors the withTimeout shape already used in services/featureFreeze.ts and
 * services/vto/vtoFeatureControl.ts, with one deliberate difference: it
 * RESOLVES rather than rejects. Its one caller is best-effort logout cleanup,
 * where a rejection would only have to be caught and mapped straight back to a
 * reason code -- and where an unhandled rejection is exactly the failure mode
 * being repaired.
 */
function withDeadline<T>(operation: Promise<T>, timeoutMs: number, onDeadline: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onDeadline);
    }, timeoutMs);
    const finish = (value: T) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Both arms are attached, so a rejection that lands AFTER the deadline is
    // still consumed and can never surface as an unhandled rejection.
    operation.then(finish, () => finish(onDeadline));
  });
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
  | {
      ok: false;
      reason:
        | 'unsupported_platform'
        /**
         * Android Repair 05: this build ships no feature that consumes remote
         * push, so no permission is requested and no token is minted. Distinct
         * from `unsupported_platform`, which is about the RUNTIME (web) rather
         * than about what this build actually ships.
         */
        | 'capability_unavailable'
        | 'permission_denied'
        | 'token_failed'
        | 'register_failed'
        | 'request_failed';
    };

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

  // Android Repair 05. The canonical activation gate, consulted BEFORE any
  // permission prompt or token acquisition. Reaching this function already
  // required a Watch to exist, so on a Watchlist-enabled build the capability
  // is on by construction; the check is here so that EVERY token-acquiring
  // path in this module answers to one authority rather than to whichever
  // gate happens to guard its own entry point.
  if (!resolveRemotePushActivationAllowed()) {
    return { ok: false, reason: 'capability_unavailable' };
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
  // N-6: and the route that now exists belongs to THIS actor. Recorded on
  // every path that registers, so the Settings control and the token-refresh
  // listener read the same fact.
  await recordDevicePushOwnerForCurrentActor();

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
    const claim = await supabase.functions.invoke('commerce-watch-refresh', {
      body: { action: 'claim_device', deviceId },
    });
    // N-6. A SUCCEEDED claim is the moment this device's ownership becomes
    // knowable: the server has just retired every live route on it that does
    // not belong to the arriving actor, so the only route that can still exist
    // here is theirs -- and only if they already had one.
    //
    // A failed claim tells us nothing, so nothing is written.
    if (claim.error) return;
    const arriving = currentActorId();
    if (!arriving) return;
    const owner = await readDevicePushOwner();
    if (owner === null) {
      // Pre-N-6 install: no record was ever written, and this device has an id,
      // so a registration happened at some point. Attributing it to the actor
      // present at this claim matches what the pre-N-6 code already assumed,
      // and converts the install to the exact scheme for every later
      // transition. Deliberately NOT written as "no owner": that would present
      // OFF over a route that may well be live, which is the one direction of
      // untruth this repair must never introduce.
      await writeDevicePushOwner(arriving);
      return;
    }
    if (owner !== arriving) {
      await writeDevicePushOwner(NO_DEVICE_PUSH_OWNER);
    }
  } catch {
    // Silent: a failed claim must never fail or delay a sign-in. The server
    // still retires the foreign route the moment this actor registers.
  }
}

/**
 * RP-109. Explicit network deadline for the sign-out push-revocation attempt.
 *
 * Chosen conservatively rather than borrowed: the closest existing precedent,
 * services/featureFreeze.ts, uses 2500ms for a config read that blocks a render
 * -- a tighter budget than this needs. This one runs once per sign-out, on a
 * handset that may be on a slow mobile network, and a revocation that DOES land
 * is worth a short wait because it stops a departed actor's Watch alerts (item
 * title and price) reaching whoever holds the handset next. Four seconds is
 * long enough for an ordinary round trip on a poor connection and short enough
 * that a hung request is never mistaken by the user for a failed logout.
 *
 * The number is the ceiling, not the cost: a normal revocation resolves in the
 * time the request takes and the timer is cleared immediately.
 */
export const LOGOUT_PUSH_REVOCATION_DEADLINE_MS = 4000;

/**
 * Bounded reason code for one sign-out revocation attempt. Deliberately a
 * closed set of opaque tokens: no device id, push token, access token, email,
 * backend body or error text may leave this module (§19).
 */
export type LogoutPushRevocationOutcome =
  | 'revoked'
  | 'not_registered'
  | 'no_session'
  | 'failed'
  | 'timed_out';

/** The unbounded body of the revocation. Never rejects; see the wrapper. */
async function revokeThisDevicePushRoute(): Promise<LogoutPushRevocationOutcome> {
  // N-6: captured SYNCHRONOUSLY, before the first await, so it names the actor
  // who is signing out rather than whoever happens to be current when this
  // resolves. Sign-out awaits this revocation BEFORE it advances the actor
  // epoch, so at this line the departing actor is still the live one.
  const departing = currentActorId();
  try {
    const deviceId = await readDeviceId();
    if (!deviceId) return 'not_registered';
    const session = await resolveAuthenticatedFunctionSession();
    if (session.ok === false) return 'no_session';
    const result = await supabase.functions.invoke('commerce-watch-refresh', {
      body: { action: 'revoke_push_token', deviceId },
    });
    if (result.error) return 'failed';
    // N-6: the route this device held for the departing actor is gone, so the
    // ownership record must stop claiming otherwise -- otherwise that actor
    // signing back in would find a Settings control reading ON over a route
    // that no longer exists.
    //
    // RP-109 INTACT: this is a COMPARE-and-clear naming the departing actor.
    // A completion that lands after the deadline, after the next actor has
    // signed in, and even after that actor has registered, finds a record that
    // no longer names `departing` and writes nothing. The helper still mutates
    // no state belonging to any other actor.
    await releaseDevicePushOwnerIfHeldBy(departing);
    return 'revoked';
  } catch {
    return 'failed';
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
 * RP-109: the wait is now EXPLICITLY BOUNDED at
 * LOGOUT_PUSH_REVOCATION_DEADLINE_MS. Previously this awaited the network with
 * no deadline, so a request that hung — a captive portal, a stalled TLS
 * handshake, a dead radio — held sign-out open indefinitely and trapped the
 * user inside the authenticated session. Push cleanup matters, but ending the
 * session is the action the user actually asked for, so the deadline always
 * wins. An abandoned request is harmless: the server holds the invariant
 * independently, and the arriving actor's claim_device retires the route
 * anyway.
 *
 * Never throws and never blocks past the deadline. Does nothing at all when
 * this device never registered — it deliberately does not mint a device id.
 * Returns a bounded reason code (never raw error material) so the caller can
 * record the outcome; the caller is free to ignore it. It mutates NO
 * actor-bound state, which is what makes a completion that lands after the
 * next actor has signed in structurally incapable of touching them.
 */
export async function revokeWatchAlertsForThisDevice(): Promise<LogoutPushRevocationOutcome> {
  return withDeadline(
    revokeThisDevicePushRoute(),
    LOGOUT_PUSH_REVOCATION_DEADLINE_MS,
    'timed_out',
  );
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
  /**
   * Android Repair 05: no feature that ships in this build consumes remote
   * push, so the OS permission is never requested and no push token is
   * acquired. The onboarding surface renders a passive, non-requesting row in
   * this state, so this reason is the fail-closed backstop rather than a
   * routine user-visible outcome.
   */
  | 'capability_unavailable'
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

  // Android Repair 05. Push-token acquisition is a consent boundary: it is
  // only legitimate when something in THIS build can actually send the user a
  // push. Checked before the permission prompt, so a build with no push
  // consumer never asks. `canAskAgain: false` because retrying changes
  // nothing -- the answer is a property of the build, not of the user's
  // previous choice.
  if (!resolveRemotePushActivationAllowed()) {
    return { ok: false, reason: 'capability_unavailable', canAskAgain: false };
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
  // N-6: the same registration, recorded against the actor it was made for.
  await recordDevicePushOwnerForCurrentActor();

  return { ok: true, canAskAgain: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// RP-104: the canonical device-level DISABLE.
// ─────────────────────────────────────────────────────────────────────────────

export type DisableDeviceNotificationsFailureReason =
  | 'backend_unavailable'
  /**
   * N-6: this device's local registration state could not be read, so whether a
   * backend route exists here is UNKNOWN. Reported as a failure rather than as
   * an "already unregistered" success, because the caller must not present a
   * confirmed OFF over a route that may still be delivering.
   */
  | 'device_state_unreadable';

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

  const stored = await readDeviceIdWithFault();
  if (stored.ok === false) {
    // N-6: unreadable is not "unregistered". The explicit intent is still
    // recorded (a best-effort write that suppresses automatic re-registration
    // if storage recovers), but no OFF is claimed and no route is asserted
    // absent. Mints nothing, prompts for nothing, calls nothing.
    await markDevicePushExplicitlyDisabled();
    return { ok: false, reason: 'device_state_unreadable' };
  }
  const deviceId = stored.deviceId;
  if (!deviceId) {
    // No identifier means no route. Record the explicit intent and stop —
    // no minted id, no token, no permission prompt, no backend call.
    await markDevicePushExplicitlyDisabled();
    // N-6: and there is provably nothing registered here for anyone.
    await writeDevicePushOwner(NO_DEVICE_PUSH_OWNER);
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

  // N-6: written only AFTER a revocation that actually landed. A failed revoke
  // leaves the record exactly as it was, because the route may still be live
  // and a Settings control that read "not registered" over it would be the
  // false OFF this lane exists to prevent.
  await writeDevicePushOwner(NO_DEVICE_PUSH_OWNER);

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
  // Android Repair 05. This listener exists for exactly one purpose -- to
  // RE-REGISTER a rolled token -- so on a build with no push consumer it is
  // pure activation with nothing behind it. Refused before the dynamic import,
  // so expo-notifications' native module is not even loaded, and a no-op
  // disposer is returned so the caller's cleanup path is unchanged.
  //
  // This suppresses only AUTOMATIC re-registration. Revocation
  // (revokeWatchAlertsForThisDevice, disableDeviceNotifications) and actor
  // handoff (claimDeviceForCurrentActor) stay ungated on purpose: a device
  // that registered under an earlier build must still be able to retire that
  // route.
  if (!resolveRemotePushActivationAllowed()) return () => {};

  const Notifications = await import('expo-notifications');
  const subscription = Notifications.addPushTokenListener(() => {
    void (async () => {
      const deviceId = await readDeviceId();
      if (!deviceId) return;
      // RP-104: an automatic refresh may never re-arm a route the user
      // explicitly turned off. Checked before any network work.
      if (await isDevicePushExplicitlyDisabled()) return;
      // N-6: nor may it arm a route for an actor who never asked for one.
      //
      // The device id survives every revocation by design, so before this
      // check "an id exists and no OFF marker stands" was enough to register.
      // After a sign-out or an account switch that is a DIFFERENT actor at the
      // keyboard: the departed actor's route was revoked (RP-109) or retired
      // (claim_device), and a rolled token would silently build a brand-new
      // K Scan delivery route for someone who never opted in -- while the
      // Settings control, reading the same records, truthfully showed OFF.
      //
      // Deliberately narrow: an ABSENT record (a pre-N-6 install) still
      // registers, exactly as it did before, so no device that legitimately
      // opted in loses NOTIF-16 token-refresh recovery. Only a record that
      // positively names no owner, or a different actor, refuses.
      const owner = await readDevicePushOwner();
      if (owner !== null && owner !== currentActorId()) return;
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
