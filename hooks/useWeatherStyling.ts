import { useCallback, useEffect, useState } from 'react';
import { WEATHER_STYLING_CONTEXT_ENABLED, type WeatherLocationInput } from '../constants/weatherStyling';
import {
  readWeatherPermission,
  setWeatherPermissionState,
  noteStyleChatSessionOpened,
  isPromptEligible,
  readLocationDisclosureChoice,
  setLocationDisclosureChoice,
  type WeatherPermissionRecord,
} from '../services/weather/weatherPermissionStore';
import {
  requestForegroundWeatherPermission,
  getForegroundPermissionStatus,
  getWeatherLocationInput,
} from '../services/weather/weatherStylingContext';

// A slow GPS fix must never noticeably delay a chat send. If the foreground fix
// does not resolve quickly, we skip weather for that message.
const LOCATION_FIX_TIMEOUT_MS = 2_000;

export type WeatherChipState = 'off' | 'active' | 'denied';

export interface UseWeatherStylingReturn {
  enabled: boolean;
  checking: boolean;
  promptVisible: boolean;
  requesting: boolean;
  chipState: WeatherChipState;
  markStylingIntent: () => void;
  acceptWeather: () => Promise<void>;
  dismissPrompt: () => Promise<void>;
  // Awaited by the send path; returns null (skip weather) on any failure/timeout.
  getWeatherLocation: () => Promise<WeatherLocationInput | null>;
}

export function useWeatherStyling(sessionId: string): UseWeatherStylingReturn {
  const enabled = WEATHER_STYLING_CONTEXT_ENABLED;
  const [record, setRecord] = useState<WeatherPermissionRecord | null>(null);
  const [checking, setChecking] = useState(true);
  const [intent, setIntent] = useState(false);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Advances the dismiss-session counter, then loads the current preference.
      await noteStyleChatSessionOpened();

      // Check real OS permission status before deciding to show the disclosure.
      // This prevents a disclosure flash for users who already granted or denied.
      const osStatus = await getForegroundPermissionStatus();
      const disclosureSeen = await readLocationDisclosureChoice();
      let r = await readWeatherPermission();

      if (osStatus === 'granted') {
        // Already granted by the OS: keep the prompt hidden and remember the choice.
        r = await setWeatherPermissionState('granted');
        await setLocationDisclosureChoice();
      } else if ((osStatus === 'denied' || osStatus === 'unavailable') && disclosureSeen) {
        // User already saw the disclosure and the OS permission is not granted:
        // do not nag again; weather stays optional.
        if (r.state !== 'granted' && r.state !== 'denied') {
          r = await setWeatherPermissionState('denied');
        }
      }
      // Otherwise (not asked yet, or denied without disclosure seen) fall through
      // and let the existing eligibility logic decide whether to show the disclosure.

      if (!cancelled) {
        setRecord(r);
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId]);

  const eligible = enabled && record ? isPromptEligible(record) : false;
  const promptVisible = enabled && !checking && intent && eligible && !dismissedThisSession;

  const markStylingIntent = useCallback(() => {
    if (enabled) setIntent(true);
  }, [enabled]);

  const acceptWeather = useCallback(async () => {
    setRequesting(true);
    try {
      await setLocationDisclosureChoice();
      const result = await requestForegroundWeatherPermission();
      // 'unavailable' (flag off / module error): hide the prompt, leave state untouched.
      if (result === 'unavailable') {
        setDismissedThisSession(true);
        return;
      }
      const updated = await setWeatherPermissionState(result === 'granted' ? 'granted' : 'denied');
      setRecord(updated);
      setDismissedThisSession(true);
    } finally {
      setRequesting(false);
    }
  }, []);

  const dismissPrompt = useCallback(async () => {
    // Hide immediately; persist 'dismissed' so we respect the re-prompt cooldown.
    setDismissedThisSession(true);
    await setLocationDisclosureChoice();
    const updated = await setWeatherPermissionState('dismissed');
    setRecord(updated);
  }, []);

  const getWeatherLocation = useCallback(async (): Promise<WeatherLocationInput | null> => {
    if (!enabled || record?.state !== 'granted') return null;
    return Promise.race([
      getWeatherLocationInput(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCATION_FIX_TIMEOUT_MS)),
    ]);
  }, [enabled, record?.state]);

  const chipState: WeatherChipState = !enabled
    ? 'off'
    : record?.state === 'granted'
      ? 'active'
      : record?.state === 'denied'
        ? 'denied'
        : 'off';

  return {
    enabled,
    checking,
    promptVisible,
    requesting,
    chipState,
    markStylingIntent,
    acceptWeather,
    dismissPrompt,
    getWeatherLocation,
  };
}
