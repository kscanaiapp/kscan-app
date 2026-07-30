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
