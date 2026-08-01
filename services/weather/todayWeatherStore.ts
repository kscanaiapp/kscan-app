import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TodayWeatherInput } from '../todayWithElise/weatherPolicy';

/**
 * Shared weather state between StyleChat and Today with Elise.
 *
 * WHY THIS EXISTS
 *
 * The app has exactly one weather pipeline: the client sends rounded coarse
 * coordinates to `stylechat-generate`, which calls Open-Meteo and classifies the
 * result server-side. Today with Elise cannot call that function itself — it
 * requires a sessionId and a message, creates chat rows, and consumes the user's
 * generation quota — so Today reuses what a chat turn already resolved instead of
 * fetching anything of its own. This store is that handoff, and it is the reason
 * there is no second provider call, no second classifier, and no second
 * permission prompt.
 *
 * CONSEQUENCE, STATED PLAINLY: Today shows weather only after StyleChat has
 * resolved it at least once while location permission was granted. Before that
 * there is nothing to show, and the card falls back exactly as it does when
 * weather is denied or unavailable.
 *
 * WHAT IS STORED: only the compact projection the backend returns — a coarse
 * condition, a whole-degree temperature, and an observation timestamp. Never
 * coordinates (rounded or otherwise), never the raw provider payload.
 */

/** Namespaced beside the existing weather permission preference. */
const TODAY_WEATHER_KEY = '@style_dna_v1/weather/lastContext';

/**
 * Hard ceiling on how long a cached payload may be *retained*. Usability for
 * Today copy is decided separately and more strictly by
 * `resolveTodayWeatherSuitability` against TODAY_WEATHER_FRESHNESS_MS; this only
 * stops an ancient record from lingering in storage indefinitely.
 */
export const TODAY_WEATHER_RETENTION_MS = 6 * 60 * 60 * 1000;

/** The wire shape returned by stylechat-generate's optional weatherContext field. */
export type WeatherContextWire = {
  temperatureC: number | null;
  temperatureF: number | null;
  precipitation: TodayWeatherInput['precipitation'];
  condition: TodayWeatherInput['condition'];
  observedAt: string;
};

export type StoredTodayWeather = {
  schemaVersion: 1;
  /** Owner of the reading. A different actor must never read this record. */
  actorId: string;
  temperatureC: number | null;
  temperatureF: number | null;
  precipitation: TodayWeatherInput['precipitation'];
  condition: TodayWeatherInput['condition'];
  capturedAtMs: number;
};

/** Absent or explicitly null is valid; any other type is malformed. */
function optionalFiniteNumber(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

const CONDITIONS: ReadonlySet<string> = new Set([
  'clear',
  'clouds',
  'rain',
  'snow',
  'wind',
  'unknown',
]);
const PRECIPITATION: ReadonlySet<string> = new Set(['none', 'light', 'heavy', 'unknown']);

/**
 * Validate an untrusted `weatherContext` payload.
 *
 * Returns null rather than throwing for every malformed shape: a backend that
 * predates this field, a partial rollout, or a corrupted body must degrade to
 * "no weather" and never surface an exception into Home.
 */
export function parseWeatherContextWire(raw: unknown): WeatherContextWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.condition !== 'string' || !CONDITIONS.has(r.condition)) return null;
  if (typeof r.precipitation !== 'string' || !PRECIPITATION.has(r.precipitation)) return null;
  if (typeof r.observedAt !== 'string') return null;
  if (!Number.isFinite(Date.parse(r.observedAt))) return null;

  // Absent OR explicitly null is legitimate — the backend reports a null
  // temperature when the provider omitted it. Any other type is malformed.
  const c = optionalFiniteNumber(r.temperatureC);
  if (!c.ok) return null;
  const f = optionalFiniteNumber(r.temperatureF);
  if (!f.ok) return null;

  return {
    temperatureC: c.value,
    temperatureF: f.value,
    precipitation: r.precipitation as TodayWeatherInput['precipitation'],
    condition: r.condition as TodayWeatherInput['condition'],
    observedAt: r.observedAt,
  };
}

/**
 * Persist a reading a chat turn just resolved. Best-effort and always
 * non-throwing — a storage failure must never break the chat send it rode in on.
 */
export async function saveTodayWeather(actorId: string, raw: unknown): Promise<void> {
  const parsed = parseWeatherContextWire(raw);
  if (!parsed || !actorId) return;
  const record: StoredTodayWeather = {
    schemaVersion: 1,
    actorId,
    temperatureC: parsed.temperatureC,
    temperatureF: parsed.temperatureF,
    precipitation: parsed.precipitation,
    condition: parsed.condition,
    capturedAtMs: Date.parse(parsed.observedAt),
  };
  try {
    await AsyncStorage.setItem(TODAY_WEATHER_KEY, JSON.stringify(record));
  } catch {
    // Non-fatal: weather is optional everywhere it is consumed.
  }
}

/**
 * Read the last stored reading for this actor, as the exact input shape
 * `resolveTodayWeatherSuitability` expects.
 *
 * Returns null — never throws — when nothing is stored, the record belongs to a
 * different actor, the payload is malformed, or it is past the retention
 * ceiling. Freshness for copy purposes is still the policy's decision, not this
 * function's.
 */
export async function readTodayWeather(
  actorId: string,
  nowMs: number = Date.now(),
): Promise<TodayWeatherInput | null> {
  if (!actorId) return null;
  try {
    const raw = await AsyncStorage.getItem(TODAY_WEATHER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed.actorId !== actorId) return null;
    if (typeof parsed.condition !== 'string' || !CONDITIONS.has(parsed.condition)) return null;
    if (typeof parsed.precipitation !== 'string' || !PRECIPITATION.has(parsed.precipitation)) {
      return null;
    }
    const capturedAtMs =
      typeof parsed.capturedAtMs === 'number' && Number.isFinite(parsed.capturedAtMs)
        ? parsed.capturedAtMs
        : NaN;
    if (!Number.isFinite(capturedAtMs)) return null;
    if (nowMs - capturedAtMs > TODAY_WEATHER_RETENTION_MS) return null;

    const temperatureC =
      typeof parsed.temperatureC === 'number' && Number.isFinite(parsed.temperatureC)
        ? parsed.temperatureC
        : null;
    const temperatureF =
      typeof parsed.temperatureF === 'number' && Number.isFinite(parsed.temperatureF)
        ? parsed.temperatureF
        : null;

    return {
      temperatureC,
      temperatureF,
      precipitation: parsed.precipitation as TodayWeatherInput['precipitation'],
      condition: parsed.condition as TodayWeatherInput['condition'],
      capturedAtMs,
      // Always 'cache': this value was resolved by an earlier chat turn, never by
      // a live read on Home's behalf.
      source: 'cache',
    };
  } catch {
    return null;
  }
}

/** Clears the stored reading. Used on sign-out so weather cannot cross accounts. */
export async function clearTodayWeather(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TODAY_WEATHER_KEY);
  } catch {
    // ignore
  }
}

export { TODAY_WEATHER_KEY };
