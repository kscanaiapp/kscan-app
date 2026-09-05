import { useState, useCallback, useRef } from 'react';
import {
  enableDeviceNotifications,
  type EnableDeviceNotificationsResult,
} from '../services/watchlist/pushRegistration';
import { Platform, PermissionsAndroid } from 'react-native';

import { VOICESCAN_ENABLED } from '../constants/featureFlags';

export type PermissionKey = 'camera' | 'photos' | 'microphone' | 'notifications';

export type PermissionPreferencesStatus =
  | 'local_only'
  | 'saving'
  | 'saved'
  | 'error'
  | 'backend_not_connected';

export interface PermissionPreferences {
  camera: boolean;
  photos: boolean;
  microphone: boolean;
  notifications: boolean;
}

export interface SavePreferencesResult {
  ok: boolean;
  persisted: false;
  backendConnected: false;
  reason: 'backend_not_connected';
}

export interface MicrophonePermissionResult {
  granted: boolean;
  canAskAgain: boolean;
  error: string | null;
}

export interface UsePermissionPreferencesReturn {
  preferences: PermissionPreferences;
  status: PermissionPreferencesStatus;
  isSaving: boolean;
  error: string | null;
  backendConnected: false;
  setPreference: (key: PermissionKey, value: boolean) => void;
  togglePreference: (key: PermissionKey) => void;
  savePreferences: () => Promise<SavePreferencesResult>;
  resetPreferences: () => void;
  requestMicrophonePermission: () => Promise<MicrophonePermissionResult>;
  requestNotificationPermission: () => Promise<EnableDeviceNotificationsResult>;
}

const DEFAULT_PREFERENCES: PermissionPreferences = {
  camera: false,
  photos: false,
  microphone: false,
  notifications: false,
};

/**
 * Placeholder hook for permission preference management.
 *
 * Backend integration not yet connected.
 * All operations are in-memory with async-safe delays.
 * Future backend wiring will not break callers because the contract is async today.
 */
export function usePermissionPreferences(): UsePermissionPreferencesReturn {
  const [preferences, setPreferences] = useState<PermissionPreferences>({ ...DEFAULT_PREFERENCES });
  const [status, setStatus] = useState<PermissionPreferencesStatus>('local_only');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialRef = useRef<PermissionPreferences>({ ...DEFAULT_PREFERENCES });

  const setPreference = useCallback((key: PermissionKey, value: boolean) => {
    setPreferences((prev) => ({ ...prev, [key]: value }));
  }, []);

  const togglePreference = useCallback((key: PermissionKey) => {
    setPreferences((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const savePreferences = useCallback(async (): Promise<SavePreferencesResult> => {
    setIsSaving(true);
    setStatus('saving');
    setError(null);

    // Async-safe delay to force UI loading state handling now.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // No backend connected — placeholder success
    setIsSaving(false);
    setStatus('backend_not_connected');

    return {
      ok: true,
      persisted: false,
      backendConnected: false,
      reason: 'backend_not_connected',
    };
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences({ ...initialRef.current });
    setStatus('local_only');
    setError(null);
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
    status,
    isSaving,
    error,
    backendConnected: false,
    setPreference,
    togglePreference,
    savePreferences,
    resetPreferences,
    requestMicrophonePermission,
    requestNotificationPermission,
  };
}
