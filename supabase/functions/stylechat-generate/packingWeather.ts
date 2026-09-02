// K+ Packing Intelligence V1 — weather enrichment (B3).
//
// WEATHER IS ENRICHMENT, NEVER FOUNDATION. Everything here can fail, time out,
// or find nothing, and Packing still produces the same plan it produced in B2M
// with provenance UNAVAILABLE. Nothing in this file may throw into the handler.
//
// NO NEW PROVIDER. Open-Meteo is already this function's weather authority for
// Today-with-Elise (index.ts, /v1/forecast, keyless, 1.5s budget). Two things
// it did not do are added here, because a trip is not "here, now":
//   - a DESTINATION instead of the user's rounded GPS, which needs Open-Meteo's
//     own geocoding endpoint
//   - a DATE RANGE instead of current conditions, which is the same /v1/forecast
//     endpoint with daily= and start_date/end_date
// Same provider, same absence of a credential, same fail-open discipline.
//
// SEASONAL IS DELIBERATELY UNREACHABLE. The contract carries three provenances
// because the UI and the prompt must be able to distinguish them, but this
// project has NO source of climate normals -- /v1/forecast returns a forecast or
// nothing. Rather than label a forecast "typical" or invent an average, a trip
// beyond the forecast horizon resolves to UNAVAILABLE. A test asserts this
// resolver can never emit SEASONAL, so the gap is a proven decision rather than
// an oversight waiting to be filled with a guess.
//
// WHAT LEAVES THE FUNCTION: the destination string the traveller typed, and
// nothing else. No user id, no Closet, no trip note, no dates attached to an
// identity. The coordinates that come back are rounded before use.

import type { PackingWeatherProvenance } from './packingContract.ts';

const GEOCODE_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';

const GEOCODE_TIMEOUT_MS = 1_500;
const FORECAST_TIMEOUT_MS = 2_000;

/**
 * Open-Meteo's public forecast horizon. Beyond it the endpoint returns nulls
 * rather than an error, which would otherwise become a confident summary built
 * from nothing.
 */
export const FORECAST_HORIZON_DAYS = 16;

const CACHE_TTL_MS = 30 * 60 * 1_000;
const MS_PER_DAY = 86_400_000;

export interface PackingWeatherResult {
  /**
   * UNAVAILABLE is deliberately NOT in this union: this resolver returns null
   * for it, so an absent answer cannot be mistaken at the type level for a
   * present one carrying an empty label.
   */
  provenance: Exclude<PackingWeatherProvenance, 'UNAVAILABLE'>;
  summary: string;
  /**
   * The place the GEOCODER actually chose, e.g. "Springfield, Missouri, US".
   *
   * PK-002. `count=1` means one candidate comes back and it is used silently.
   * "Springfield" resolves to Missouri, "Portland" to Oregon, and "Georgia" to
   * the COUNTRY rather than the US state -- a different hemisphere's worth of
   * packing advice. The traveller saw only the string they typed above a
   * confident forecast line, so a wrong city was undetectable and drove real
   * garment choices. Naming the resolved place is what makes it correctable.
   */
  resolvedLocation: string | null;
}

/**
 * Task-local, in-memory, keyed by normalized destination + date range. Exists
 * for one reason: ten refinements of the same trip must not become ten
 * identical weather calls. Deliberately NOT a durable table, not a per-user
 * weather profile, and not a general caching subsystem -- an edge instance is
 * ephemeral and correctness never depends on this.
 */
const weatherCache = new Map<string, { result: PackingWeatherResult | null; cachedAt: number }>();

/** Case/whitespace/punctuation-insensitive, so "New York" and "new york," share an entry. */
export function packingWeatherCacheKey(
  destination: string,
  startDate: string,
  endDate: string,
): string {
  const normalized = destination
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${normalized}|${startDate}|${endDate}`;
}

function roundCoord(value: number): number {
  // ~1km. A city centroid does not need more, and less precision leaves the
  // network with less than it was given.
  return Math.round(value * 100) / 100;
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function geocodeDestination(
  destination: string,
  fetchImpl: typeof fetch,
): Promise<{ latitude: number; longitude: number; label: string | null } | null> {
  const query = destination.trim();
  if (!query) return null;

  const url = new URL(GEOCODE_BASE);
  url.searchParams.set('name', query.slice(0, 80));
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const body = await fetchJson(url.toString(), GEOCODE_TIMEOUT_MS, fetchImpl);
  const results = Array.isArray(body?.results) ? (body!.results as Array<Record<string, unknown>>) : [];
  const first = results[0];
  const latitude = typeof first?.latitude === 'number' ? first.latitude : NaN;
  const longitude = typeof first?.longitude === 'number' ? first.longitude : NaN;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  // Built from the provider's own fields, never from the typed string, so it
  // can actually DISAGREE with what the traveller wrote -- which is the entire
  // point of showing it.
  const label = [
    typeof first?.name === 'string' ? first.name : null,
    typeof first?.admin1 === 'string' ? first.admin1 : null,
    typeof first?.country_code === 'string' ? first.country_code : null,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(', ')
    .slice(0, 80);
  return {
    latitude: roundCoord(latitude),
    longitude: roundCoord(longitude),
    label: label || null,
  };
}

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

function summarize(daily: Record<string, unknown>): string | null {
  const highs = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const lows = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];

  const numericHighs = highs.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const numericLows = lows.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  // A window the endpoint answered with nulls is no data at all. Reporting it
  // as a forecast would be the exact failure this whole module is shaped to
  // avoid.
  if (numericHighs.length === 0 || numericLows.length === 0) return null;

  const maxHigh = Math.round(Math.max(...numericHighs));
  const minHigh = Math.round(Math.min(...numericHighs));
  const minLow = Math.round(Math.min(...numericLows));

  const rainDays = codes.filter(
    (code): code is number => typeof code === 'number' && RAIN_CODES.has(code),
  ).length;
  const snowDays = codes.filter(
    (code): code is number => typeof code === 'number' && SNOW_CODES.has(code),
  ).length;
  const totalDays = Math.max(numericHighs.length, codes.length);

  const parts = [
    minHigh === maxHigh ? `highs around ${maxHigh}F` : `highs ${minHigh}-${maxHigh}F`,
    `lows near ${minLow}F`,
  ];
  if (snowDays > 0) {
    parts.push(`snow on ${snowDays} of ${totalDays} days`);
  } else if (rainDays > 0) {
    parts.push(`rain on ${rainDays} of ${totalDays} days`);
  } else {
    parts.push('mostly dry');
  }
  return parts.join(', ');
}

export async function fetchDestinationForecast(input: {
  latitude: number;
  longitude: number;
  startDate: string;
  endDate: string;
  fetchImpl: typeof fetch;
}): Promise<string | null> {
  const url = new URL(FORECAST_BASE);
  url.searchParams.set('latitude', String(input.latitude));
  url.searchParams.set('longitude', String(input.longitude));
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weather_code');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('start_date', input.startDate);
  url.searchParams.set('end_date', input.endDate);
  url.searchParams.set('timezone', 'auto');

  const body = await fetchJson(url.toString(), FORECAST_TIMEOUT_MS, input.fetchImpl);
  const daily =
    body?.daily && typeof body.daily === 'object' && !Array.isArray(body.daily)
      ? (body.daily as Record<string, unknown>)
      : null;
  if (!daily) return null;
  return summarize(daily);
}

/** True when the whole trip lies inside the provider's forecast horizon. */
export function isWithinForecastHorizon(startDate: string, endDate: string, nowMs: number): boolean {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const today = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
  // A trip that already started is still forecastable for its remaining days;
  // one that ended is not.
  if (end < today) return false;
  return start <= today + FORECAST_HORIZON_DAYS * MS_PER_DAY;
}

/**
 * Resolves weather for a trip, or null. NEVER throws and never returns a
 * summary it did not actually receive.
 */
export async function resolvePackingWeather(input: {
  destination: string;
  startDate: string;
  endDate: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<PackingWeatherResult | null> {
  const now = input.now ?? (() => Date.now());
  const fetchImpl = input.fetchImpl ?? fetch;
  const key = packingWeatherCacheKey(input.destination, input.startDate, input.endDate);

  const cached = weatherCache.get(key);
  if (cached && now() - cached.cachedAt < CACHE_TTL_MS) return cached.result;

  const store = (result: PackingWeatherResult | null): PackingWeatherResult | null => {
    weatherCache.set(key, { result, cachedAt: now() });
    return result;
  };

  // Outside the horizon there is nothing honest to say, and no seasonal
  // authority to fall back to. Cached as a miss so a refinement loop does not
  // re-ask a question whose answer cannot change within the TTL.
  if (!isWithinForecastHorizon(input.startDate, input.endDate, now())) return store(null);

  try {
    const coords = await geocodeDestination(input.destination, fetchImpl);
    if (!coords) return store(null);

    const summary = await fetchDestinationForecast({
      latitude: coords.latitude,
      longitude: coords.longitude,
      startDate: input.startDate,
      endDate: input.endDate,
      fetchImpl,
    });
    if (!summary) return store(null);

    return store({ provenance: 'FORECAST', summary, resolvedLocation: coords.label });
  } catch {
    return store(null);
  }
}

/** Test seam. Never called from the request path. */
export function clearPackingWeatherCache(): void {
  weatherCache.clear();
}
