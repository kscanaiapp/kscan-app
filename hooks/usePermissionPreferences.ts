import { useState, useCallback } from 'react';
import {
  enableDeviceNotifications,
  type EnableDeviceNotificationsResult,
} from '../services/watchlist/pushRegistration';
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

  const requestNotificationPermission = useCallback(async (): Promise<EnableDeviceNotificationsResult> => {
    const result = await enableDeviceNotifications();
    // Reflect the REAL outcome only -- never optimistically flip this on
    // before the OS/registration result is known, and never on failure.
    setPreference('notifications', result.ok);
    return result;
  }, [setPreference]);

  return {
    preferences,
    setPreference,
    requestMicrophonePermission,
    requestNotificationPermission,
  };
}
