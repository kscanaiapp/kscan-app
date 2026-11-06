import { useState, useCallback, useRef, useEffect } from 'react';
import {
  disableDeviceNotifications,
  enableDeviceNotifications,
  type DisableDeviceNotificationsResult,
  type EnableDeviceNotificationsResult,
} from '../services/watchlist/pushRegistration';
import { captureActorScope, isActorScopeCurrent } from '../services/actorScope';
import { Platform, PermissionsAndroid } from 'react-native';

import { VOICESCAN_ENABLED } from '../constants/featureFlags';
import {
  readScannerMediaChoices,
  saveScannerMediaChoice,
  type ScannerMediaChoice,
} from '../services/scannerMediaChoices';

/** Only Notifications reflects an OS/device registration outcome here. Scanner choices are app-local. */
export type PermissionKey = 'notifications';

export interface PermissionPreferences {
  camera: boolean;
  photos: boolean;
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
  mediaReady: boolean;
  mediaBusy: boolean;
  mediaError: string | null;
  setScannerMediaChoice: (key: ScannerMediaChoice, value: boolean) => Promise<void>;
  retryScannerMediaChoices: () => Promise<void>;
  requestMicrophonePermission: () => Promise<MicrophonePermissionResult>;
  requestNotificationPermission: () => Promise<EnableDeviceNotificationsResult>;
  /**
   * RP-104: the explicit OFF. Revokes THIS device's backend push-delivery
   * route and only then reflects OFF locally.
   */
  disableNotificationDelivery: () => Promise<DisableDeviceNotificationsResult>;
}

const DEFAULT_PREFERENCES: PermissionPreferences = {
  camera: true,
  photos: true,
  notifications: false,
};

/**
 * Reflects the real outcome of the notification registration flow.
 *
 * Microphone remains a point-of-use OS permission. Camera and Photos are
 * real, device-local Scanner usage choices; the OS grant is still point-of-use.
 * A stored OFF must never be interpreted as an OS permission change.
 */
export function usePermissionPreferences(): UsePermissionPreferencesReturn {
  const [preferences, setPreferences] = useState<PermissionPreferences>({ ...DEFAULT_PREFERENCES });
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const mediaMutationInFlight = useRef(false);

  const retryScannerMediaChoices = useCallback(async () => {
    setMediaReady(false);
    setMediaError(null);
    try {
      const stored = await readScannerMediaChoices();
      setPreferences((prev) => ({ ...prev, camera: stored.camera, photos: stored.photos }));
      setMediaReady(true);
    } catch {
      // Fail closed: never display ON as a verified choice when storage cannot
      // be read. The Scanner independently refuses unverified media access.
      setMediaError('Could not load your Scanner choices. Retry to continue.');
    }
  }, []);

  useEffect(() => {
    void retryScannerMediaChoices();
  }, [retryScannerMediaChoices]);

  const setScannerMediaChoice = useCallback(async (key: ScannerMediaChoice, value: boolean) => {
    if (!mediaReady || mediaMutationInFlight.current) return;
    mediaMutationInFlight.current = true;
    setMediaBusy(true);
    setMediaError(null);
    try {
      const saved = await saveScannerMediaChoice(key, value);
      setPreferences((prev) => ({ ...prev, camera: saved.camera, photos: saved.photos }));
    } catch {
      setMediaError('Could not save your Scanner choice. Please try again.');
    } finally {
      mediaMutationInFlight.current = false;
      setMediaBusy(false);
    }
  }, [mediaReady]);

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
    mediaReady,
    mediaBusy,
    mediaError,
    setScannerMediaChoice,
    retryScannerMediaChoices,
    requestMicrophonePermission,
    requestNotificationPermission,
    disableNotificationDelivery,
  };
}
