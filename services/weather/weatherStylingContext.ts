import * as Location from 'expo-location';
import {
  WEATHER_STYLING_CONTEXT_ENABLED,
  roundCoordinate,
  type WeatherLocationInput,
} from '../../constants/weatherStyling';

// Foreground-only location acquisition for Weather-Aware StyleChat.
//
// Privacy invariants (see also weatherPermissionStore):
//   - foreground location only; never background, never continuous
//   - raw lat/lon is used transiently to compute rounded values, then discarded
//   - only rounded coordinates ever leave this module (to the Edge Function)
//   - nothing here writes GPS to storage or logs

export type WeatherPermissionRequestResult = 'granted' | 'denied' | 'unavailable';

/**
 * Observed status, which unlike a request result can be "never asked". Keeping
 * `undetermined` distinct from `denied` is what stops an unanswered OS prompt
 * from being recorded as a refusal the user never gave.
 */
export type WeatherPermissionStatus = WeatherPermissionRequestResult | 'undetermined';

// Requests foreground permission only. Returns a coarse status; the caller maps it
// to the persisted permission state. After an explicit request, anything other
// than granted is a real refusal.
export async function requestForegroundWeatherPermission(): Promise<WeatherPermissionRequestResult> {
  if (!WEATHER_STYLING_CONTEXT_ENABLED) return 'unavailable';
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

export async function getForegroundPermissionStatus(): Promise<WeatherPermissionStatus> {
  if (!WEATHER_STYLING_CONTEXT_ENABLED) return 'unavailable';
  try {
    const { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
    if (status === 'granted') return 'granted';
    // Expo reports UNDETERMINED before the OS prompt has ever been answered.
    // Reporting that as 'denied' would let the caller persist a refusal the user
    // never made, permanently disabling a feature they were never asked about.
    if (status === Location.PermissionStatus.UNDETERMINED) return 'undetermined';
    // A non-granted status that can still be asked again has not been refused
    // outright either — the OS is still willing to show the prompt.
    return canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unavailable';
  }
}

// Reads a single foreground fix and returns a privacy-reduced payload. Returns null
// on any failure so weather can be skipped without ever blocking StyleChat.
export async function getWeatherLocationInput(
  locale?: string,
): Promise<WeatherLocationInput | null> {
  if (!WEATHER_STYLING_CONTEXT_ENABLED) return null;
  try {
    const status = await getForegroundPermissionStatus();
    if (status !== 'granted') return null;

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Low, // city-scale is plenty for weather; lighter + more private
    });

    // Round immediately; the raw fix is never stored, logged, or forwarded.
    const roundedLat = roundCoordinate(position.coords.latitude);
    const roundedLon = roundCoordinate(position.coords.longitude);

    return {
      enabled: true,
      source: 'gps_foreground',
      roundedLat,
      roundedLon,
      requestedAt: new Date().toISOString(),
      ...(locale ? { locale } : {}),
    };
  } catch {
    return null;
  }
}
