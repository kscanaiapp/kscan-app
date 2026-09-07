import { useState, useCallback, useRef } from 'react';
import {
  disableDeviceNotifications,
  enableDeviceNotifications,
  type DisableDeviceNotificationsResult,
  type EnableDeviceNotificationsResult,
} from '../services/watchlist/pushRegistration';
import { captureActorScope, isActorScopeCurrent } from '../services/actorScope';
import { Platform, PermissionsAndroid } from 'react-native';

import { VOICESCAN_ENABLED } from '../constants/featureFlags';

/** Only Notifications reflects a real device registration outcome here. */
export type PermissionKey = 'notifications';

export interface PermissionPreferences {
  notifications: boolean;
}

export interface MicrophonePermissionResult {
  granted: boolean;
  canAskAgain: boolean;
  error: string | null;
}

export interface UsePermissionPreferencesReturn {
  preferences: PermissionPreferences;
  setPreference: (key: PermissionKey, value: boolean) => void;
  requestMicrophonePermission: () => Promise<MicrophonePermissionResult>;
  requestNotificationPermission: () => Promise<EnableDeviceNotificationsResult>;
  /**
   * RP-104: the explicit OFF. Revokes THIS device's backend push-delivery
   * route and only then reflects OFF locally.
   */
  disableNotificationDelivery: () => Promise<DisableDeviceNotificationsResult>;
}

const DEFAULT_PREFERENCES: PermissionPreferences = {
  notifications: false,
};

/**
 * Reflects the real outcome of the notification registration flow.
 *
 * Camera, Photos, and Microphone are point-of-use capabilities, not saved
 * onboarding preferences. This hook deliberately owns no fake persistence for
 * those education cards.
 */
export function usePermissionPreferences(): UsePermissionPreferencesReturn {
  const [preferences, setPreferences] = useState<PermissionPreferences>({ ...DEFAULT_PREFERENCES });

  const setPreference = useCallback((key: PermissionKey, value: boolean) => {
    setPreferences((prev) => ({ ...prev, [key]: value }));
  }, []);

  const requestMicrophonePermission = useCallback(async (): Promise<MicrophonePermissionResult> => {
    if (Platform.OS !== 'android' || !VOICESCAN_ENABLED) {
      return { granted: false, canAskAgain: false, error: null };
    }

    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Enable VoiceScan microphone',
          message:
            'VoiceScan uses your microphone only when you start a voice or wearable input action. K Scan AI does not listen in the background.',
          buttonPositive: 'Allow',
        }
      );

      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        return { granted: true, canAskAgain: true, error: null };
      }

      const blocked = result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN;
      return { granted: false, canAskAgain: !blocked, error: null };
    } catch (err) {
      return {
        granted: false,
        canAskAgain: false,
        error: err instanceof Error ? err.message : 'Microphone permission request failed',
      };
    }
  }, []);

  /**
   * RP-104 stale-completion control, shared by both directions of the switch.
   *
   * Monotonic, so the LAST toggle the user made is the only one allowed to
   * write state: an earlier request that resolves afterwards sees a moved
   * counter and mutates nothing. This is what stops a slow ON from settling
   * the UI to ON after the user has since turned it OFF, and vice versa.
   */
  const notificationRequestSeqRef = useRef(0);

  /**
   * True only if `token` is still the newest notification request AND the
   * actor generation captured with it is still live.
   *
   * The actor half reuses services/actorScope.ts — the project's existing
   * authority, whose epoch increments on every auth transition — rather than
   * a second lifecycle. A captured user id alone would not do: it matches
   * again after an A -> B -> A cycle, and `isAuthenticated` never changes at
   * all across an A -> B switch.
   */
  const canApplyNotificationResult = useCallback(
    (token: number, scope: ReturnType<typeof captureActorScope>): boolean =>
      token === notificationRequestSeqRef.current && isActorScopeCurrent(scope),
    [],
  );

  const requestNotificationPermission = useCallback(async (): Promise<EnableDeviceNotificationsResult> => {
    const token = (notificationRequestSeqRef.current += 1);
    const scope = captureActorScope();
    const result = await enableDeviceNotifications();
    // Reflect the REAL outcome only -- never optimistically flip this on
    // before the OS/registration result is known, and never on failure.
    // Discarded with ZERO mutation when superseded or when the actor changed:
    // the departing actor's completion must not paint the arriving one's UI.
    if (!canApplyNotificationResult(token, scope)) return result;
    setPreference('notifications', result.ok);
    return result;
  }, [canApplyNotificationResult, setPreference]);

  const disableNotificationDelivery = useCallback(async (): Promise<DisableDeviceNotificationsResult> => {
    const token = (notificationRequestSeqRef.current += 1);
    const scope = captureActorScope();
    const result = await disableDeviceNotifications();
    if (!canApplyNotificationResult(token, scope)) return result;
    // OFF is reflected ONLY after the backend route was actually revoked. A
    // failed revocation leaves the switch where it was, because the device is
    // still a live K Scan AI push destination and showing OFF would be a lie.
    if (result.ok) setPreference('notifications', false);
    return result;
  }, [canApplyNotificationResult, setPreference]);

  return {
    preferences,
    setPreference,
    requestMicrophonePermission,
    requestNotificationPermission,
    disableNotificationDelivery,
  };
}
