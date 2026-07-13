import AsyncStorage from '@react-native-async-storage/async-storage';
import { STYLE_DNA_NAMESPACE } from './localStyleDnaFeedbackStore';

// ── Style DNA Phase 3 (start) — local reason-code enrichment ─────────────────────
// Optional "why" behind a Helpful / Not-my-style tap, stored DEVICE-LOCAL only.
//   - No raw message text. No backend. No remote persistence. No migration.
//   - Reason capture is always optional: a feedback tap works with no reason.
//   - Lives under its own sub-namespace so it is isolated from Phase 0 feedback,
//     yet still inside @style_dna_v1/ so a full Style DNA wipe clears it too.
//   - Per-user reset supported (clearReasonsForUser) and wired into profile reset.

const REASONS_PREFIX = `${STYLE_DNA_NAMESPACE}reasons/`;

// Independent feature flag. Default disabled (undefined/"false" → off, "true" → on).
export const STYLE_DNA_REASON_FEEDBACK_ENABLED =
  process.env.EXPO_PUBLIC_STYLE_DNA_REASON_FEEDBACK_ENABLED === 'true';

export type StyleDnaFeedbackValue = 'helpful' | 'not_my_style';

export const HELPFUL_REASON_CODES = [
  'practical',
  'matches_my_style',
  'good_for_occasion',
  'would_try',
] as const;

export const NOT_MY_STYLE_REASON_CODES = [
  'too_bold',
  'too_plain',
  'too_dressy',
  'too_casual',
  'not_practical',
  'would_not_wear',
] as const;

export type HelpfulReasonCode = (typeof HELPFUL_REASON_CODES)[number];
export type NotMyStyleReasonCode = (typeof NOT_MY_STYLE_REASON_CODES)[number];
export type StyleDnaReasonCode = HelpfulReasonCode | NotMyStyleReasonCode;

const HELPFUL_SET = new Set<string>(HELPFUL_REASON_CODES);
const NOT_MY_STYLE_SET = new Set<string>(NOT_MY_STYLE_REASON_CODES);

export function isValidReasonCode(value: unknown): value is StyleDnaReasonCode {
  return typeof value === 'string' && (HELPFUL_SET.has(value) || NOT_MY_STYLE_SET.has(value));
}

// A reason code must match the feedback polarity it was given for.
export function isReasonValidForFeedback(
  value: unknown,
  feedback: StyleDnaFeedbackValue,
): value is StyleDnaReasonCode {
  if (typeof value !== 'string') return false;
  return feedback === 'helpful' ? HELPFUL_SET.has(value) : NOT_MY_STYLE_SET.has(value);
}

// The reason chips a caller should offer for a given feedback tap.
export function reasonCodesForFeedback(
  feedback: StyleDnaFeedbackValue,
): readonly StyleDnaReasonCode[] {
  return feedback === 'helpful' ? HELPFUL_REASON_CODES : NOT_MY_STYLE_REASON_CODES;
}

export type LocalStyleDnaReason = {
  schemaVersion: 1;
  userKey: string;
  sessionId: string;
  messageId: string;
  feedback: StyleDnaFeedbackValue;
  reasonCode: StyleDnaReasonCode;
  createdAt: string;
  updatedAt: string;
};

type ReasonSessionMap = {
  schemaVersion: 1;
  userKey: string;
  sessionId: string;
  reasonByMessageId: Record<string, LocalStyleDnaReason>;
  updatedAt: string;
};

function sessionKey(userKey: string, sessionId: string): string {
  return `${REASONS_PREFIX}${userKey}/${sessionId}`;
}

function emptyMap(userKey: string, sessionId: string): ReasonSessionMap {
  return {
    schemaVersion: 1,
    userKey,
    sessionId,
    reasonByMessageId: {},
    updatedAt: new Date().toISOString(),
  };
}

function isFeedbackValue(value: unknown): value is StyleDnaFeedbackValue {
  return value === 'helpful' || value === 'not_my_style';
}

// Drop anything malformed or polarity-mismatched; never throws on read.
function normalizeRecord(
  raw: unknown,
  userKey: string,
  sessionId: string,
  messageId: string,
): LocalStyleDnaReason | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isFeedbackValue(r.feedback)) return null;
  if (!isReasonValidForFeedback(r.reasonCode, r.feedback)) return null;
  const createdAt =
    typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date().toISOString();
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : createdAt;
  return {
    schemaVersion: 1,
    userKey,
    sessionId,
    messageId,
    feedback: r.feedback,
    reasonCode: r.reasonCode as StyleDnaReasonCode,
    createdAt,
    updatedAt,
  };
}

function normalizeMap(
  raw: string | null,
  userKey: string,
  sessionId: string,
): ReasonSessionMap {
  if (!raw) return emptyMap(userKey, sessionId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMap(userKey, sessionId);
  }
  if (!parsed || typeof parsed !== 'object') return emptyMap(userKey, sessionId);
  const p = parsed as Record<string, unknown>;
  const source =
    p.reasonByMessageId && typeof p.reasonByMessageId === 'object'
      ? (p.reasonByMessageId as Record<string, unknown>)
      : {};

  const reasonByMessageId: Record<string, LocalStyleDnaReason> = {};
  for (const [messageId, value] of Object.entries(source)) {
    const record = normalizeRecord(value, userKey, sessionId, messageId);
    if (record) reasonByMessageId[messageId] = record;
  }

  return {
    schemaVersion: 1,
    userKey,
    sessionId,
    reasonByMessageId,
    updatedAt:
      typeof p.updatedAt === 'string' && p.updatedAt ? p.updatedAt : new Date().toISOString(),
  };
}

async function readSessionMap(userKey: string, sessionId: string): Promise<ReasonSessionMap> {
  try {
    const raw = await AsyncStorage.getItem(sessionKey(userKey, sessionId));
    return normalizeMap(raw, userKey, sessionId);
  } catch {
    return emptyMap(userKey, sessionId);
  }
}

async function readSessionMapForWrite(
  userKey: string,
  sessionId: string,
): Promise<ReasonSessionMap> {
  const raw = await AsyncStorage.getItem(sessionKey(userKey, sessionId));
  return normalizeMap(raw, userKey, sessionId);
}

// One in-flight write chain per storage key (mirrors the feedback store).
const writeChains = new Map<string, Promise<unknown>>();
function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  writeChains.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ── Public API ──────────────────────────────────────────────────────────────────

export async function getReasonForMessage(params: {
  userKey: string;
  sessionId: string;
  messageId: string;
}): Promise<LocalStyleDnaReason | null> {
  const { userKey, sessionId, messageId } = params;
  if (!userKey || !sessionId || !messageId) return null;
  const map = await readSessionMap(userKey, sessionId);
  return map.reasonByMessageId[messageId] ?? null;
}

// Persists an optional reason for a feedback tap. Invalid or polarity-mismatched
// codes are rejected (throw) so callers never silently store junk. Never stores text.
export async function setReasonForMessage(params: {
  userKey: string;
  sessionId: string;
  messageId: string;
  feedback: StyleDnaFeedbackValue;
  reasonCode: StyleDnaReasonCode;
}): Promise<LocalStyleDnaReason> {
  const { userKey, sessionId, messageId, feedback, reasonCode } = params;
  if (!userKey || !sessionId || !messageId) {
    throw new Error('Signature Style reason requires userKey, sessionId, and messageId.');
  }
  if (!isFeedbackValue(feedback)) {
    throw new Error('Invalid Signature Style feedback value.');
  }
  if (!isReasonValidForFeedback(reasonCode, feedback)) {
    throw new Error('Invalid Signature Style reason code for the given feedback.');
  }

  const key = sessionKey(userKey, sessionId);
  return enqueueWrite(key, async () => {
    const map = await readSessionMapForWrite(userKey, sessionId);
    const now = new Date().toISOString();
    const existing = map.reasonByMessageId[messageId];
    const record: LocalStyleDnaReason = {
      schemaVersion: 1,
      userKey,
      sessionId,
      messageId,
      feedback,
      reasonCode,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    map.reasonByMessageId[messageId] = record;
    map.updatedAt = now;
    await AsyncStorage.setItem(key, JSON.stringify(map));
    return record;
  });
}

// Removes a single reason (e.g. user deselects the chip) without touching feedback.
export async function clearReasonForMessage(params: {
  userKey: string;
  sessionId: string;
  messageId: string;
}): Promise<void> {
  const { userKey, sessionId, messageId } = params;
  if (!userKey || !sessionId || !messageId) return;
  const key = sessionKey(userKey, sessionId);
  await enqueueWrite(key, async () => {
    const map = await readSessionMapForWrite(userKey, sessionId);
    if (map.reasonByMessageId[messageId]) {
      delete map.reasonByMessageId[messageId];
      map.updatedAt = new Date().toISOString();
      await AsyncStorage.setItem(key, JSON.stringify(map));
    }
  });
}

export type StyleDnaReasonCounts = {
  totalReasons: number;
  byReasonCode: Partial<Record<StyleDnaReasonCode, number>>;
  byFeedback: { helpful: number; not_my_style: number };
};

// Aggregates reason counts for a single user across all their sessions. Corrupted
// maps are skipped, never thrown.
export async function getReasonCountsForUser(params: {
  userKey: string;
}): Promise<StyleDnaReasonCounts> {
  const empty: StyleDnaReasonCounts = {
    totalReasons: 0,
    byReasonCode: {},
    byFeedback: { helpful: 0, not_my_style: 0 },
  };
  const { userKey } = params;
  if (!userKey) return empty;

  const prefix = `${REASONS_PREFIX}${userKey}/`;
  let keys: readonly string[] = [];
  try {
    keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
  } catch {
    return empty;
  }
  if (keys.length === 0) return empty;

  // multiGet returns a readonly KeyValuePair[]; keep entries readonly-compatible and
  // build the per-key fallback in a separate mutable local (behavior unchanged).
  let entries: readonly (readonly [string, string | null])[] = [];
  try {
    entries = await AsyncStorage.multiGet(keys as string[]);
  } catch {
    const fallback: [string, string | null][] = [];
    for (const k of keys) {
      try {
        fallback.push([k, await AsyncStorage.getItem(k)]);
      } catch {
        // skip
      }
    }
    entries = fallback;
  }

  const counts: StyleDnaReasonCounts = {
    totalReasons: 0,
    byReasonCode: {},
    byFeedback: { helpful: 0, not_my_style: 0 },
  };
  for (const [key, raw] of entries) {
    const sessionId = key.slice(prefix.length);
    const map = normalizeMap(raw, userKey, sessionId);
    for (const record of Object.values(map.reasonByMessageId)) {
      counts.totalReasons += 1;
      counts.byFeedback[record.feedback] += 1;
      counts.byReasonCode[record.reasonCode] =
        (counts.byReasonCode[record.reasonCode] ?? 0) + 1;
    }
  }
  return counts;
}

// Per-user reset. Called from resetLocalStyleDnaProfile so a Style DNA reset clears
// reasons for the current user too. Does not touch other users or other namespaces.
export async function clearReasonsForUser(userKey: string): Promise<void> {
  if (!userKey) return;
  const prefix = `${REASONS_PREFIX}${userKey}/`;
  let keys: readonly string[] = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return;
  }
  const toRemove = keys.filter((k) => k.startsWith(prefix));
  if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove as string[]);
}
