import AsyncStorage from '@react-native-async-storage/async-storage';
import { SIGNATURE_STYLE_NAMESPACE } from './localSignatureStyleFeedbackStore';

// ── Signature Style UI preferences — device-local, actor-scoped ───────────────
// These control the reduced-footprint feedback UX. They are NOT sent to Supabase
// and are NOT part of the learned Signature Style profile; they are pure UI state.

const PREFERENCES_PREFIX = `${SIGNATURE_STYLE_NAMESPACE}preferences/`;

export type LocalSignatureStylePreferences = {
  learnFromFeedback: boolean;
  showFeedbackControls: boolean;
  feedbackEducationDismissed: boolean;
};

export const DEFAULT_SIGNATURE_STYLE_PREFERENCES: LocalSignatureStylePreferences = Object.freeze({
  learnFromFeedback: true,
  showFeedbackControls: false,
  feedbackEducationDismissed: false,
});

type PreferencesListener = () => void;

const snapshotByUser = new Map<string, LocalSignatureStylePreferences>();
const listenersByUser = new Map<string, Set<PreferencesListener>>();
const hydratedUsers = new Set<string>();
const hydrationByUser = new Map<string, Promise<LocalSignatureStylePreferences>>();
const writeChains = new Map<string, Promise<unknown>>();
const revisionByUser = new Map<string, number>();

function preferencesKey(userKey: string): string {
  return `${PREFERENCES_PREFIX}${userKey}`;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function normalizePreferences(raw: string | null): LocalSignatureStylePreferences {
  const prefs = { ...DEFAULT_SIGNATURE_STYLE_PREFERENCES };
  if (!raw) return prefs;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return prefs;
  }

  if (!parsed || typeof parsed !== 'object') return prefs;
  const p = parsed as Record<string, unknown>;

  if (isBoolean(p.learnFromFeedback)) prefs.learnFromFeedback = p.learnFromFeedback;
  if (isBoolean(p.showFeedbackControls)) prefs.showFeedbackControls = p.showFeedbackControls;
  if (isBoolean(p.feedbackEducationDismissed)) prefs.feedbackEducationDismissed = p.feedbackEducationDismissed;
  if (!prefs.learnFromFeedback) prefs.showFeedbackControls = false;

  return prefs;
}

function currentRevision(userKey: string): number {
  return revisionByUser.get(userKey) ?? 0;
}

function advanceRevision(userKey: string): number {
  const next = currentRevision(userKey) + 1;
  revisionByUser.set(userKey, next);
  return next;
}

function samePreferences(a: LocalSignatureStylePreferences, b: LocalSignatureStylePreferences): boolean {
  return (
    a.learnFromFeedback === b.learnFromFeedback &&
    a.showFeedbackControls === b.showFeedbackControls &&
    a.feedbackEducationDismissed === b.feedbackEducationDismissed
  );
}

function publishSnapshot(userKey: string, next: LocalSignatureStylePreferences): LocalSignatureStylePreferences {
  const current = snapshotByUser.get(userKey);
  if (current && samePreferences(current, next)) return current;
  snapshotByUser.set(userKey, next);
  listenersByUser.get(userKey)?.forEach((listener) => listener());
  return next;
}

async function readStoredPreferences(userKey: string): Promise<LocalSignatureStylePreferences> {
  if (!userKey) return DEFAULT_SIGNATURE_STYLE_PREFERENCES;
  try {
    return normalizePreferences(await AsyncStorage.getItem(preferencesKey(userKey)));
  } catch {
    return DEFAULT_SIGNATURE_STYLE_PREFERENCES;
  }
}

async function readStoredPreferencesForWrite(
  userKey: string,
): Promise<LocalSignatureStylePreferences> {
  return normalizePreferences(await AsyncStorage.getItem(preferencesKey(userKey)));
}

function enqueueWrite<T>(userKey: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(userKey) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(userKey, next.then(() => undefined, () => undefined));
  return next;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getSignatureStylePreferences(userKey: string): Promise<LocalSignatureStylePreferences> {
  return readStoredPreferences(userKey);
}

export function getSignatureStylePreferencesSnapshot(
  userKey: string | null | undefined,
): LocalSignatureStylePreferences {
  if (!userKey) return DEFAULT_SIGNATURE_STYLE_PREFERENCES;
  return snapshotByUser.get(userKey) ?? DEFAULT_SIGNATURE_STYLE_PREFERENCES;
}

export function subscribeSignatureStylePreferences(
  userKey: string | null | undefined,
  listener: PreferencesListener,
): () => void {
  if (!userKey) return () => {};
  const listeners = listenersByUser.get(userKey) ?? new Set<PreferencesListener>();
  listeners.add(listener);
  listenersByUser.set(userKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByUser.delete(userKey);
  };
}

export async function hydrateSignatureStylePreferences(
  userKey: string | null | undefined,
): Promise<LocalSignatureStylePreferences> {
  if (!userKey) return DEFAULT_SIGNATURE_STYLE_PREFERENCES;
  if (hydratedUsers.has(userKey)) return getSignatureStylePreferencesSnapshot(userKey);
  const pending = hydrationByUser.get(userKey);
  if (pending) return pending;

  const startingRevision = currentRevision(userKey);
  const hydration = readStoredPreferences(userKey)
    .then((next) => {
      if (currentRevision(userKey) !== startingRevision) {
        return getSignatureStylePreferencesSnapshot(userKey);
      }
      hydratedUsers.add(userKey);
      return publishSnapshot(userKey, next);
    })
    .finally(() => {
      hydrationByUser.delete(userKey);
    });
  hydrationByUser.set(userKey, hydration);
  return hydration;
}

export async function setSignatureStylePreferences(
  userKey: string,
  update: Partial<LocalSignatureStylePreferences>,
): Promise<LocalSignatureStylePreferences> {
  if (!userKey) throw new Error('Signature Style preferences require a userKey.');

  advanceRevision(userKey);
  return enqueueWrite(userKey, async () => {
    const current = await readStoredPreferencesForWrite(userKey);
    const learnFromFeedback = isBoolean(update.learnFromFeedback)
      ? update.learnFromFeedback
      : current.learnFromFeedback;
    const next: LocalSignatureStylePreferences = {
      learnFromFeedback,
      showFeedbackControls: learnFromFeedback
        ? isBoolean(update.showFeedbackControls)
          ? update.showFeedbackControls
          : current.showFeedbackControls
        : false,
      feedbackEducationDismissed: isBoolean(update.feedbackEducationDismissed)
        ? update.feedbackEducationDismissed
        : current.feedbackEducationDismissed,
    };

    await AsyncStorage.setItem(preferencesKey(userKey), JSON.stringify(next));
    hydratedUsers.add(userKey);
    publishSnapshot(userKey, next);
    return next;
  });
}

export async function clearSignatureStylePreferencesForUser(userKey: string): Promise<void> {
  if (!userKey) return;
  advanceRevision(userKey);
  try {
    await AsyncStorage.removeItem(preferencesKey(userKey));
    hydratedUsers.add(userKey);
    publishSnapshot(userKey, DEFAULT_SIGNATURE_STYLE_PREFERENCES);
  } catch {
    // best-effort
  }
}

export async function clearAllSignatureStylePreferences(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const toRemove = keys.filter((k) => k.startsWith(PREFERENCES_PREFIX));
    if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
    for (const userKey of snapshotByUser.keys()) {
      advanceRevision(userKey);
      hydratedUsers.add(userKey);
      publishSnapshot(userKey, DEFAULT_SIGNATURE_STYLE_PREFERENCES);
    }
  } catch {
    // best-effort
  }
}
