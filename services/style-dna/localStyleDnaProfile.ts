import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  STYLE_DNA_NAMESPACE,
  clearLocalStyleDnaForUser,
} from './localStyleDnaFeedbackStore';

// ── Style DNA Phase 1 — local profile summary ───────────────────────────────────
// Derives a compact, device-local summary from the Phase 0 feedback signals
// (helpful / not_my_style). Phase 0 stores NO message text, so the honest summary
// is counts and engagement only — no fabricated style traits. Read-only over the
// existing feedback storage; adds no new persisted state of its own.

// Flag: undefined/"false" -> disabled, "true" -> enabled. Default disabled.
export const STYLE_DNA_PROFILE_ENABLED =
  process.env.EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED === 'true';

const SESSIONS_PREFIX = `${STYLE_DNA_NAMESPACE}sessions/`;

// Minimum signals before we surface a compact summary to the model — avoids
// overclaiming personalization from one or two taps.
const MIN_SIGNALS_FOR_SUMMARY_TEXT = 3;

export type LocalStyleDnaProfileSummary = {
  schemaVersion: 1;
  userKey: string;
  helpfulCount: number;
  notMyStyleCount: number;
  totalSignals: number;
  helpfulRatio: number | null; // helpful / total, or null when there are no signals
  sessionsWithFeedback: number;
  lastUpdatedAt: string | null;
  generatedAt: string;
};

function emptySummary(userKey: string): LocalStyleDnaProfileSummary {
  return {
    schemaVersion: 1,
    userKey,
    helpfulCount: 0,
    notMyStyleCount: 0,
    totalSignals: 0,
    helpfulRatio: null,
    sessionsWithFeedback: 0,
    lastUpdatedAt: null,
    generatedAt: new Date().toISOString(),
  };
}

async function readAllUserSessionMaps(userKey: string): Promise<string[]> {
  const prefix = `${SESSIONS_PREFIX}${userKey}/`;
  let keys: readonly string[] = [];
  try {
    keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
  if (keys.length === 0) return [];
  try {
    const entries = await AsyncStorage.multiGet(keys as string[]);
    return entries.map(([, value]) => value).filter((v): v is string => typeof v === 'string');
  } catch {
    // Fallback: read individually so one flaky read doesn't drop the whole profile.
    const out: string[] = [];
    for (const k of keys) {
      try {
        const v = await AsyncStorage.getItem(k);
        if (typeof v === 'string') out.push(v);
      } catch {
        // skip
      }
    }
    return out;
  }
}

// Aggregates all local feedback for a user into a single summary. Corrupted maps
// are skipped, never thrown.
export async function getStyleDnaProfileSummary(params: {
  userKey: string;
}): Promise<LocalStyleDnaProfileSummary> {
  const { userKey } = params;
  if (!userKey) return emptySummary(userKey);

  const rawMaps = await readAllUserSessionMaps(userKey);
  if (rawMaps.length === 0) return emptySummary(userKey);

  let helpfulCount = 0;
  let notMyStyleCount = 0;
  let sessionsWithFeedback = 0;
  let lastUpdatedMs = 0;
  let lastUpdatedAt: string | null = null;

  for (const raw of rawMaps) {
    let map: unknown;
    try {
      map = JSON.parse(raw);
    } catch {
      continue;
    }
    const byId =
      map && typeof map === 'object'
        ? (map as Record<string, unknown>).feedbackByMessageId
        : null;
    if (!byId || typeof byId !== 'object') continue;

    let sessionHasSignal = false;
    for (const value of Object.values(byId as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const rec = value as Record<string, unknown>;
      if (rec.feedback === 'helpful') {
        helpfulCount += 1;
        sessionHasSignal = true;
      } else if (rec.feedback === 'not_my_style') {
        notMyStyleCount += 1;
        sessionHasSignal = true;
      }
      const ts = typeof rec.updatedAt === 'string' ? Date.parse(rec.updatedAt) : NaN;
      if (Number.isFinite(ts) && ts > lastUpdatedMs) {
        lastUpdatedMs = ts;
        lastUpdatedAt = rec.updatedAt as string;
      }
    }
    if (sessionHasSignal) sessionsWithFeedback += 1;
  }

  const totalSignals = helpfulCount + notMyStyleCount;
  return {
    schemaVersion: 1,
    userKey,
    helpfulCount,
    notMyStyleCount,
    totalSignals,
    helpfulRatio: totalSignals > 0 ? helpfulCount / totalSignals : null,
    sessionsWithFeedback,
    lastUpdatedAt,
    generatedAt: new Date().toISOString(),
  };
}

// Compact, cautious summary text for optional StyleChat injection. Returns null
// when the flag is off or there is not enough signal. Counts only — no invented
// style traits, no overclaimed personalization.
export function buildStyleDnaSummaryText(summary: LocalStyleDnaProfileSummary): string | null {
  if (!STYLE_DNA_PROFILE_ENABLED) return null;
  if (summary.totalSignals < MIN_SIGNALS_FOR_SUMMARY_TEXT) return null;
  return (
    `The user has reacted to past styling replies: ${summary.helpfulCount} marked helpful ` +
    `and ${summary.notMyStyleCount} marked not their style. Use only as a light signal of ` +
    `what resonates; do not overclaim personalization or invent preferences.`
  );
}

// Reset: the profile is derived from local feedback, so clearing feedback resets it.
export async function resetLocalStyleDnaProfile(userKey: string): Promise<void> {
  await clearLocalStyleDnaForUser(userKey);
}
