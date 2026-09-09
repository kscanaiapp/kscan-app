/**
 * N-6 — the post-onboarding device notification control's view model.
 *
 * WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * It owns exactly one thing: an honest, hydrated, race-safe rendering of TWO
 * separate facts that a single boolean cannot express.
 *
 *   A. K Scan's own delivery route on THIS device, for THIS actor.
 *      Owned by services/watchlist/pushRegistration.ts (RP-104). Something
 *      K Scan can create and destroy.
 *
 *   B. The operating system's notification authorization for K Scan.
 *      Owned by iOS/Android. Something K Scan can only READ and, at most, ask
 *      about once. It can never revoke it, and this hook never claims it can.
 *
 * Collapsing those into one boolean is what makes a notification toggle lie.
 * A device can be K Scan-ON with the OS blocking delivery (nothing arrives,
 * and only the user can fix it, in Settings), or K Scan-OFF with the OS
 * happily granted (nothing arrives, and the app alone can fix it). Both states
 * are rendered as what they are.
 *
 * It creates NO second registration or revocation implementation. Every
 * mutation goes through the canonical authority already used by onboarding:
 * enableDeviceNotifications() and disableDeviceNotifications().
 *
 * SIDE-EFFECT FREEDOM ON MOUNT (N-6 §7)
 *
 * Mounting this hook performs only reads: AsyncStorage keys and
 * `getPermissionsAsync`. It never requests permission, never acquires an Expo
 * push token, never mints a device id, never registers or revokes a route, and
 * never re-enables anything. Leaving OFF requires an explicit user action, and
 * there is exactly one path to it (`enable`).
 *
 * FEATURE CONTAINMENT (N-6 §6)
 *
 * When the build ships nothing that can send a push, the hook resolves to
 * `unavailable` and performs NO reads at all -- not even the read-only
 * permission check, whose dynamic import would load expo-notifications' native
 * module for a capability this build does not have.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

import {
  disableDeviceNotifications,
  enableDeviceNotifications,
  openNotificationSettings,
  readDeviceNotificationDeliveryState,
  readOsNotificationPermission,
  type DeviceOsNotificationPermission,
} from '../services/watchlist/pushRegistration';
import { resolveRemotePushActivationAllowed } from '../services/notifications/remotePushCapability';
import { captureActorScope, isActorScopeCurrent } from '../services/actorScope';

/**
 * What K Scan's delivery preference on this device currently is.
 *
 * `unreadable` is a first-class state, not an error to be smoothed over: if
 * local state cannot be read, neither ON nor OFF is a fact we hold, and the
 * surface must say so rather than pick one.
 */
export type DeviceNotificationControlStatus =
  | 'loading'
  | 'unavailable'
  | 'on'
  | 'off'
  | 'unreadable';

/** In-flight explicit user intent. Non-null means the control is uninteractive. */
export type DeviceNotificationPendingAction = 'enabling' | 'disabling' | null;

/**
 * Bounded, closed failure vocabulary. No backend body, status, error text,
 * device id or push token can reach the surface through this type.
 */
export type DeviceNotificationControlFailure =
  | 'enable_failed'
  | 'disable_failed'
  | 'permission_denied'
  | null;

export interface UseDeviceNotificationSettingReturn {
  status: DeviceNotificationControlStatus;
  osPermission: DeviceOsNotificationPermission;
  pending: DeviceNotificationPendingAction;
  failure: DeviceNotificationControlFailure;
  /** Explicit user ON. The ONLY path that may request permission or mint a token. */
  enable: () => Promise<void>;
  /** Explicit user OFF. Revokes this device's route through the RP-104 authority. */
  disable: () => Promise<void>;
  /** Read-only re-hydration. Used by the retry affordance on an unreadable state. */
  refresh: () => Promise<void>;
  /** Opens the OS settings app. The only recovery when the OS is blocking delivery. */
  openSystemSettings: () => void;
}

interface UseDeviceNotificationSettingOptions {
  /**
   * Stable identity of the actor whose control this is, or null when signed
   * out. Re-hydration is keyed on it because the answer is actor-specific:
   * the same handset is ON for one account and OFF for another.
   */
  actorKey: string | null;
}

export function useDeviceNotificationSetting({
  actorKey,
}: UseDeviceNotificationSettingOptions): UseDeviceNotificationSettingReturn {
  // Read once per render from THE canonical authority, exactly as the
  // onboarding surface does. Never recomposed here from a flag and a platform
  // test: one decision, one place (N-1).
  const remotePushAllowed = resolveRemotePushActivationAllowed();

  const [status, setStatus] = useState<DeviceNotificationControlStatus>(
    remotePushAllowed ? 'loading' : 'unavailable',
  );
  const [osPermission, setOsPermission] = useState<DeviceOsNotificationPermission>('unknown');
  const [pending, setPending] = useState<DeviceNotificationPendingAction>(null);
  const [failure, setFailure] = useState<DeviceNotificationControlFailure>(null);

  /**
   * Monotonic intent sequence, shared by BOTH directions of the control and by
   * hydration.
   *
   * Only explicit user intent advances it. Every write to the displayed state
   * carries the sequence it was started under and is discarded, with zero
   * mutation, if a newer intent has since begun. This is what stops a slow OFF
   * from repainting the control after the user has turned it back ON, and what
   * stops a resume-triggered re-read from overwriting a mutation that is still
   * in flight.
   */
  const intentSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * True only when `token` is still the newest intent AND the actor generation
   * captured alongside it is still live.
   *
   * The actor half reuses services/actorScope.ts — the project's existing
   * authority — rather than a second lifecycle. A captured user id alone would
   * not do: it matches again after an A -> B -> A cycle, and `isAuthenticated`
   * never changes at all across an A -> B switch. Actor A's completion must
   * never repaint actor B's control.
   */
  const canApply = useCallback(
    (token: number, scope: ReturnType<typeof captureActorScope>): boolean =>
      mountedRef.current && token === intentSeqRef.current && isActorScopeCurrent(scope),
    [],
  );

  /**
   * READ-ONLY hydration. Never advances the intent sequence — it is not user
   * intent — and never applies over a newer one.
   */
  const hydrate = useCallback(async () => {
    if (!remotePushAllowed) {
      setStatus('unavailable');
      return;
    }
    const token = intentSeqRef.current;
    const scope = captureActorScope();

    const [delivery, permission] = await Promise.all([
      readDeviceNotificationDeliveryState(),
      readOsNotificationPermission(),
    ]);

    if (!canApply(token, scope)) return;
    setOsPermission(permission);
    setStatus(
      delivery === 'enabled'
        ? 'on'
        : delivery === 'unknown'
          ? 'unreadable'
          : // 'disabled' and 'not_registered' are both OFF for delivery. The
            // distinction is real but not one a user can act on differently.
            'off',
    );
  }, [canApply, remotePushAllowed]);

  // Mount + actor change. `actorKey` is a dependency because the answer is
  // actor-specific and an account switch must re-read rather than keep showing
  // the departed actor's state.
  useEffect(() => {
    void hydrate();
  }, [hydrate, actorKey]);

  /**
   * Foreground resume. The OS permission can change while the app is
   * backgrounded — the user may have just walked to system Settings from the
   * blocked-state affordance below and changed it — and the durable delivery
   * state can be changed by a sign-out or an actor claim. Both are re-read.
   *
   * A subscription, not a poll, and strictly read-only: resuming the app
   * prompts for nothing, mints nothing and registers nothing.
   */
  useEffect(() => {
    if (!remotePushAllowed) return;
    const subscription: NativeEventSubscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next !== 'active') return;
        void hydrate();
      },
    );
    return () => subscription.remove();
  }, [hydrate, remotePushAllowed]);

  const enable = useCallback(async () => {
    // The capability gate is consulted before any user-initiated activation as
    // well as at render: a stale surface must not be able to reach the
    // permission prompt on a build with nothing to deliver.
    if (!remotePushAllowed) return;
    const token = (intentSeqRef.current += 1);
    const scope = captureActorScope();
    setPending('enabling');
    setFailure(null);
    try {
      // THE existing registration authority — the same one onboarding uses.
      // It owns the permission request, the token acquisition and the backend
      // registration, in that order and under the same capability gate.
      const result = await enableDeviceNotifications();
      if (!canApply(token, scope)) return;

      if (result.ok) {
        setStatus('on');
        // A grant is the only way to reach ok, so the OS state is known good.
        setOsPermission('granted');
        return;
      }

      if (result.reason === 'superseded') {
        // A newer explicit OFF won. Nothing to report: the control already
        // reflects the decision the user actually ended on.
        return;
      }

      if (result.reason === 'permission_denied') {
        setOsPermission(result.canAskAgain ? 'undetermined' : 'blocked');
        setFailure('permission_denied');
        // NOT 'on'. The app-level intent was to enable, but no route exists,
        // so the control must not present a confirmed ON.
        setStatus('off');
        return;
      }

      // token_failed / missing_project_id / backend_unavailable /
      // capability_unavailable / unsupported_platform: registration did not
      // land, so no ON may be claimed. Bounded and retryable.
      setFailure('enable_failed');
      setStatus('off');
    } finally {
      if (canApply(token, scope)) setPending(null);
    }
  }, [canApply, remotePushAllowed]);

  const disable = useCallback(async () => {
    // Containment, not policy. The SERVICE's revocation stays ungated on
    // purpose -- a route that already exists must always be retireable,
    // whatever this build ships (see pushRegistration.ts). This guard is about
    // the CONTROL: on a build with no push capability there is no control, and
    // a disable that resolved here would move `status` off 'unavailable' and
    // render one.
    if (!remotePushAllowed) return;
    const token = (intentSeqRef.current += 1);
    const scope = captureActorScope();
    setPending('disabling');
    setFailure(null);
    try {
      // RP-104, unchanged: revokes THIS device's backend route only. Requests
      // no OS permission, opens no Settings, mints no device id, deletes no
      // Watch, touches no K+ entitlement, and does not sign the user out.
      const result = await disableDeviceNotifications();
      if (!canApply(token, scope)) return;

      if (result.ok) {
        setStatus('off');
        return;
      }

      // The revocation did not land, so this device may still be a live K Scan
      // push destination. Showing OFF here would be a false claim over a real
      // delivery channel — the exact defect RP-104 closed. The control is left
      // exactly where it was, with a bounded retryable failure.
      setFailure('disable_failed');
    } finally {
      if (canApply(token, scope)) setPending(null);
    }
  }, [canApply, remotePushAllowed]);

  const refresh = useCallback(async () => {
    setFailure(null);
    await hydrate();
  }, [hydrate]);

  const openSystemSettings = useCallback(() => {
    // NOTIF-11's existing recovery route. Opens the OS settings app; changes
    // nothing itself and claims nothing about what the user will do there.
    void openNotificationSettings();
  }, []);

  return {
    status,
    osPermission,
    pending,
    failure,
    enable,
    disable,
    refresh,
    openSystemSettings,
  };
}
