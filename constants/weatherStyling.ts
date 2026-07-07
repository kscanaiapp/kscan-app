// Weather-aware StyleChat — shared client constants & types (Phase 0).
//
// Automatic foreground GPS weather context so StyleChat can give practical,
// day-of styling advice. Disabled by default; enable per build profile with
// EXPO_PUBLIC_WEATHER_STYLING_CONTEXT_ENABLED=true.

// Flag rules: undefined -> disabled, "false" -> disabled, "true" -> enabled.
// Default disabled prevents accidental production permission prompts.
export const WEATHER_STYLING_CONTEXT_ENABLED =
  process.env.EXPO_PUBLIC_WEATHER_STYLING_CONTEXT_ENABLED === 'true';

// Privacy: 1 decimal place ≈ 11 km. Coarse enough to avoid pinpointing the user,
// precise enough for a reliable local temperature/condition read. Reported in the
// build notes; bump to 2 (≈1.1 km) only if local weather proves unreliable.
export const WEATHER_LOCATION_PRECISION_DECIMALS = 1;

export function roundCoordinate(value: number): number {
  return Number(value.toFixed(WEATHER_LOCATION_PRECISION_DECIMALS));
}

// Client -> Edge Function payload. Never includes raw (unrounded) coordinates.
export type WeatherLocationInput = {
  enabled: boolean;
  source: 'gps_foreground';
  roundedLat: number;
  roundedLon: number;
  requestedAt: string;
  locale?: string;
};

export type WeatherPermissionState = 'not_asked' | 'granted' | 'denied' | 'dismissed';

// Re-prompt cooldown after the user dismisses the first-party prompt.
export const WEATHER_DISMISS_COOLDOWN_DAYS = 7;
export const WEATHER_DISMISS_COOLDOWN_SESSIONS = 5;

export const WEATHER_COPY = {
  promptTitle: 'Use approximate location for weather-aware styling?',
  promptBody:
    'K Scan AI can use your approximate location to tailor StyleChat suggestions to your local weather. Location is optional, used only while you are using the app, and raw coordinates are not stored.',
  promptUse: 'Continue',
  promptNotNow: 'Not now',
  active: 'Weather-aware',
  activeLong: 'Weather-aware advice is on',
  updating: 'Weather-aware advice updating…',
  denied: 'Weather-aware styling is off. You can still chat normally.',
} as const;
