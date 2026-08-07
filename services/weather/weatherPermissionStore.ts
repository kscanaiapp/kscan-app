import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  WEATHER_DISMISS_COOLDOWN_DAYS,
  WEATHER_DISMISS_COOLDOWN_SESSIONS,
  type WeatherPermissionState,
} from '../../constants/weatherStyling';

// Stores ONLY the user's weather-permission preference — never raw GPS, never
// location history. Namespaced under the existing Style DNA local prefix.
const PERMISSION_KEY = '@style_dna_v1/weather/permissionState';

// Prominent disclosure choice flag, separate from the OS permission state.
// Set after either "Continue" or "Not now" so the disclosure is not reshown.
const DISCLOSURE_KEY = 'kscan.locationDisclosure.v1';

export type WeatherPermissionRecord = {
  schemaVersion: 1;
  state: WeatherPermissionState;
  updatedAt: string;
  dismissedAt?: string;
  // Count of StyleChat sessions opened since the prompt was last dismissed.
  sessionsSinceDismiss?: number;
};

function emptyRecord(): WeatherPermissionRecord {
  return { schemaVersion: 1, state: 'not_asked', updatedAt: new Date().toISOString() };
}

function normalizeState(value: unknown): WeatherPermissionState {
  return value === 'granted' || value === 'denied' || value === 'dismissed' || value === 'not_asked'
    ? value
    : 'not_asked';
}

export async function readWeatherPermission(): Promise<WeatherPermissionRecord> {
  try {
    const raw = await AsyncStorage.getItem(PERMISSION_KEY);
    if (!raw) return emptyRecord();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      schemaVersion: 1,
      state: normalizeState(parsed.state),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      dismissedAt: typeof parsed.dismissedAt === 'string' ? parsed.dismissedAt : undefined,
      sessionsSinceDismiss:
        typeof parsed.sessionsSinceDismiss === 'number' && Number.isFinite(parsed.sessionsSinceDismiss)
          ? parsed.sessionsSinceDismiss
          : undefined,
    };
  } catch {
    return emptyRecord();
  }
}

async function write(record: WeatherPermissionRecord): Promise<WeatherPermissionRecord> {
  try {
    await AsyncStorage.setItem(PERMISSION_KEY, JSON.stringify(record));
  } catch {
    // Non-fatal: preference persistence is best-effort; weather stays optional.
  }
  return record;
}

export async function setWeatherPermissionState(
  state: WeatherPermissionState,
): Promise<WeatherPermissionRecord> {
  const now = new Date().toISOString();
  if (state === 'dismissed') {
    return write({ schemaVersion: 1, state, updatedAt: now, dismissedAt: now, sessionsSinceDismiss: 0 });
  }
  return write({ schemaVersion: 1, state, updatedAt: now });
}

// Called once per StyleChat session open. Advances the dismiss session counter so
// a dismissed prompt can re-surface after enough sessions.
export async function noteStyleChatSessionOpened(): Promise<WeatherPermissionRecord> {
  const record = await readWeatherPermission();
  if (record.state !== 'dismissed') return record;
  return write({
    ...record,
    sessionsSinceDismiss: (record.sessionsSinceDismiss ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Decides what a StyleChat open should persist, given the live OS permission and
 * what the user has already been shown. Returns the state to write, or null to
 * leave the stored record exactly as it is.
 *
 * Writing 'denied' is a terminal act — `isPromptEligible` never re-offers after
 * it — so it is reserved for the two cases where weather genuinely cannot work:
 * the OS refused and will not ask again, or the module is unavailable. A
 * 'dismissed' record and an unanswered OS prompt both keep their cooldown, which
 * is what stops a single "Not now" from disabling weather for the whole install.
 */
export function resolveOpenPermissionState(
  osStatus: 'granted' | 'denied' | 'unavailable' | 'undetermined',
  disclosureSeen: boolean,
  currentState: WeatherPermissionState,
): WeatherPermissionState | null {
  if (osStatus === 'granted') return 'granted';
  if (!disclosureSeen) return null;
  if (osStatus !== 'denied' && osStatus !== 'unavailable') return null;
  if (currentState === 'granted' || currentState === 'denied' || currentState === 'dismissed') {
    return null;
  }
  return 'denied';
}

// Eligible to show the first-party prompt after clear styling intent.
export function isPromptEligible(record: WeatherPermissionRecord, now: number = Date.now()): boolean {
  if (record.state === 'granted' || record.state === 'denied') return false;
  if (record.state === 'not_asked') return true;
  // dismissed: re-eligible after cooldown days OR enough sessions.
  const dismissedMs = record.dismissedAt ? Date.parse(record.dismissedAt) : NaN;
  const daysPassed = Number.isFinite(dismissedMs)
    ? (now - dismissedMs) / 86_400_000 >= WEATHER_DISMISS_COOLDOWN_DAYS
    : false;
  const enoughSessions = (record.sessionsSinceDismiss ?? 0) >= WEATHER_DISMISS_COOLDOWN_SESSIONS;
  return daysPassed || enoughSessions;
}

export async function clearWeatherPermissionState(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PERMISSION_KEY);
  } catch {
    // ignore
  }
}

export async function readLocationDisclosureChoice(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(DISCLOSURE_KEY);
    return raw === 'true';
  } catch {
    return false;
  }
}

export async function setLocationDisclosureChoice(): Promise<void> {
  try {
    await AsyncStorage.setItem(DISCLOSURE_KEY, 'true');
  } catch {
    // Best-effort: a missing flag may cause the disclosure to reshown, which is
    // acceptable and still privacy-compliant.
  }
}

export async function clearLocationDisclosureChoice(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DISCLOSURE_KEY);
  } catch {
    // ignore
  }
}

export { PERMISSION_KEY as WEATHER_PERMISSION_KEY };
