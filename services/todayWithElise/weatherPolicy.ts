/**
 * Build 5 — weather behavior for Today with Elise V1.
 *
 * Weather is optional and non-blocking. Failure must never block Home,
 * card-state selection, Closet-only recommendation, or Dressing Room nav.
 *
 * Reuses the approved StyleChat weather location precision (1 decimal ≈ 11 km)
 * and permission store — no second location-permission flow.
 */

/** Freshness window for any weather payload used by Today copy influence. */
export const TODAY_WEATHER_FRESHNESS_MS = 15 * 60 * 1000;

/** Client timeout budget for optional weather enrichment. */
export const TODAY_WEATHER_TIMEOUT_MS = 2000;

export type TodayWeatherInput = {
  /** Rounded temperature in whole degrees Celsius, or null if unknown. */
  temperatureC: number | null;
  /**
   * Display-only Fahrenheit reading, supplied by the backend alongside the
   * Celsius value rather than converted from it (converting would double-round).
   * Optional: absent on any payload that predates it, and never used for a
   * suitability decision — every threshold below reads temperatureC.
   */
  temperatureF?: number | null;
  /** Coarse precipitation signal only. */
  precipitation: 'none' | 'light' | 'heavy' | 'unknown';
  /** Coarse condition label allowlist — never free-form provider prose. */
  condition:
    | 'clear'
    | 'clouds'
    | 'rain'
    | 'snow'
    | 'wind'
    | 'unknown';
  capturedAtMs: number;
  source: 'live' | 'cache' | 'unavailable';
};

export type TodayWeatherSuitability = {
  usable: boolean;
  reason:
    | 'ok'
    | 'unavailable'
    | 'stale'
    | 'timeout'
    | 'offline'
    | 'malformed'
    | 'flag_off';
  suggestOuterwear: boolean;
  suggestClosedFootwear: boolean;
  /** Deterministic copy key fragment — never fabricated weather claims. */
  copyKey: 'weather.available' | 'weather.unavailable';
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Resolve whether weather may influence outerwear/footwear suitability and
 * deterministic copy. Never fabricates weather. Never reuses stale payloads
 * outside the approved freshness window.
 */
export function resolveTodayWeatherSuitability(args: {
  weatherActive: boolean;
  weather: TodayWeatherInput | null;
  nowMs: number;
  timedOut?: boolean;
  offline?: boolean;
}): TodayWeatherSuitability {
  if (!args.weatherActive) {
    return {
      usable: false,
      reason: 'flag_off',
      suggestOuterwear: false,
      suggestClosedFootwear: false,
      copyKey: 'weather.unavailable',
    };
  }

  if (args.timedOut === true) {
    return {
      usable: false,
      reason: 'timeout',
      suggestOuterwear: false,
      suggestClosedFootwear: false,
      copyKey: 'weather.unavailable',
    };
  }

  if (args.offline === true) {
    return {
      usable: false,
      reason: 'offline',
      suggestOuterwear: false,
      suggestClosedFootwear: false,
      copyKey: 'weather.unavailable',
    };
  }

  const weather = args.weather;
  if (!weather || weather.source === 'unavailable') {
    return {
      usable: false,
      reason: 'unavailable',
      suggestOuterwear: false,
      suggestClosedFootwear: false,
      copyKey: 'weather.unavailable',
    };
  }

  if (!isFiniteNumber(weather.capturedAtMs) || weather.capturedAtMs > args.nowMs) {
    return {
      usable: false,
      reason: 'malformed',
      suggestOuterwear: false,
      suggestClosedFootwear: false,
      copyKey: 'weather.unavailable',
    };
  }

  if (args.nowMs - weather.capturedAtMs > TODAY_WEATHER_FRESHNESS_MS) {
    return {
      usable: false,
      reason: 'stale',
      suggestOuterwear: false,
      suggestClosedFootwear: false,
      copyKey: 'weather.unavailable',
    };
  }

  const temp = weather.temperatureC;
  const cold = isFiniteNumber(temp) && temp <= 12;
  const wet =
    weather.precipitation === 'light' ||
    weather.precipitation === 'heavy' ||
    weather.condition === 'rain' ||
    weather.condition === 'snow';

  return {
    usable: true,
    reason: 'ok',
    suggestOuterwear: cold || wet,
    suggestClosedFootwear: wet || (isFiniteNumber(temp) && temp <= 5),
    copyKey: 'weather.available',
  };
}

/** Coarse condition labels. Never provider prose — this allowlist is the vocabulary. */
const CONDITION_LABELS: Readonly<Record<TodayWeatherInput['condition'], string>> = Object.freeze({
  clear: 'Clear',
  clouds: 'Cloudy',
  rain: 'Rain',
  snow: 'Snow',
  wind: 'Windy',
  unknown: '',
});

/**
 * Build the compact weather line for the Today card.
 *
 * Returns null whenever the reading is unusable, so an unavailable, stale,
 * denied, offline, or malformed state renders NO line at all rather than an
 * apology or a placeholder — the card simply looks the way it always has.
 *
 * The styling cue is read from the suitability verdict, never recomputed here,
 * so there is exactly one place in the app that decides what weather implies
 * for outerwear and footwear.
 */
export function describeTodayWeather(
  weather: TodayWeatherInput | null,
  suitability: TodayWeatherSuitability,
): { summary: string; cue: string | null } | null {
  if (!suitability.usable || !weather) return null;

  // Prefer the Fahrenheit reading the backend measured; fall back to Celsius
  // rather than converting, so the number shown is always one that was actually
  // reported. If neither exists, the line carries condition only.
  const parts: string[] = [];
  if (isFiniteNumber(weather.temperatureF)) {
    parts.push(`${Math.round(weather.temperatureF)}°`);
  } else if (isFiniteNumber(weather.temperatureC)) {
    parts.push(`${Math.round(weather.temperatureC)}°C`);
  }

  const label = CONDITION_LABELS[weather.condition] ?? '';
  if (label) parts.push(label);
  if (parts.length === 0) return null;

  let cue: string | null = null;
  if (suitability.suggestOuterwear && suitability.suggestClosedFootwear) {
    cue = 'Layer up and pick closed shoes.';
  } else if (suitability.suggestOuterwear) {
    cue = 'Worth a layer.';
  } else if (suitability.suggestClosedFootwear) {
    cue = 'Closed shoes are the safer pick.';
  }

  return { summary: parts.join(' · '), cue };
}
