import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Signature Style Phase 0 — local persisted StyleChat feedback ────────────────────
// Device-local only. No backend writes, no migration, no message text stored.
// A single session-scoped map holds feedback records keyed by assistant messageId.

export const SIGNATURE_STYLE_NAMESPACE = '@style_dna_v1/';
const SESSIONS_PREFIX = `${SIGNATURE_STYLE_NAMESPACE}sessions/`;

// Feature flag. Enabled by default for internal beta; set
// EXPO_PUBLIC_STYLE_DNA_ENABLED="false" to hide the UI and skip all writes.
// Kept local to this service so no broad build/config change is needed; to
// convert to a remote/config flag later, replace this constant's source.
export const SIGNATURE_STYLE_ENABLED =
  process.env.EXPO_PUBLIC_STYLE_DNA_ENABLED !== 'false';

export type LocalSignatureStyleFeedbackValue = 'helpful' | 'not_my_style';

export type LocalSignatureStyleFeedback = {
  schemaVersion: 1;
  userKey: string;
  sessionId: string;
  messageId: string;
  feedback: LocalSignatureStyleFeedbackValue;
  messageRole: 'assistant';
  contextSource: 'style_chat';
  createdAt: string;
  updatedAt: string;
};

export type LocalSignatureStyleSessionFeedbackMap = {
  schemaVersion: 1;
  userKey: string;
  sessionId: string;
  feedbackByMessageId: Record<string, LocalSignatureStyleFeedback>;
  updatedAt: string;
};

function sessionKey(userKey: string, sessionId: string): string {
  return `${SESSIONS_PREFIX}${userKey}/${sessionId}`;
}

function isFeedbackValue(value: unknown): value is LocalSignatureStyleFeedbackValue {
  return value === 'helpful' || value === 'not_my_style';
}

function emptyMap(userKey: string, sessionId: string): LocalSignatureStyleSessionFeedbackMap {
  return {
    schemaVersion: 1,
    userKey,
    sessionId,
    feedbackByMessageId: {},
    updatedAt: new Date().toISOString(),
  };
}

// Narrow a parsed record, dropping anything malformed. Never stores message text.
function normalizeRecord(
  raw: unknown,
  userKey: string,
  sessionId: string,
  messageId: string,
): LocalSignatureStyleFeedback | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isFeedbackValue(r.feedback)) return null;
  const createdAt = typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date().toISOString();
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : createdAt;
  return {
    schemaVersion: 1,
    userKey,
    sessionId,
    messageId,
    feedback: r.feedback,
    messageRole: 'assistant',
    contextSource: 'style_chat',
    createdAt,
    updatedAt,
  };
}

// Corrupted / partial JSON recovers to an empty map rather than throwing.
function normalizeMap(
  raw: string | null,
  userKey: string,
  sessionId: string,
): LocalSignatureStyleSessionFeedbackMap {
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
    p.feedbackByMessageId && typeof p.feedbackByMessageId === 'object'
      ? (p.feedbackByMessageId as Record<string, unknown>)
      : {};

  const feedbackByMessageId: Record<string, LocalSignatureStyleFeedback> = {};
  for (const [messageId, value] of Object.entries(source)) {
    const record = normalizeRecord(value, userKey, sessionId, messageId);
    if (record) feedbackByMessageId[messageId] = record;
  }

  return {
    schemaVersion: 1,
    userKey,
    sessionId,
    feedbackByMessageId,
    updatedAt:
      typeof p.updatedAt === 'string' && p.updatedAt ? p.updatedAt : new Date().toISOString(),
  };
}

async function readSessionMap(
  userKey: string,
  sessionId: string,
): Promise<LocalSignatureStyleSessionFeedbackMap> {
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
): Promise<LocalSignatureStyleSessionFeedbackMap> {
  const raw = await AsyncStorage.getItem(sessionKey(userKey, sessionId));
  return normalizeMap(raw, userKey, sessionId);
}

// ── Write serialization ───────────────────────────────────────────────────────
// One in-flight write chain per storage key. Reads may run optimistically in the
// UI; persisted writes for the same session map never race.
const writeChains = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  // Keep the chain alive but swallow errors so one failure doesn't poison the next.
  writeChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getFeedbackForMessage(params: {
  userKey: string;
  sessionId: string;
  messageId: string;
}): Promise<LocalSignatureStyleFeedback | null> {
  const { userKey, sessionId, messageId } = params;
  if (!userKey || !sessionId || !messageId) return null;
  const map = await readSessionMap(userKey, sessionId);
  return map.feedbackByMessageId[messageId] ?? null;
}

export async function getFeedbackForSession(params: {
  userKey: string;
  sessionId: string;
}): Promise<Record<string, LocalSignatureStyleFeedback>> {
  const { userKey, sessionId } = params;
  if (!userKey || !sessionId) return {};
  const map = await readSessionMap(userKey, sessionId);
  return map.feedbackByMessageId;
}

export async function setFeedbackForMessage(params: {
  userKey: string;
  sessionId: string;
  messageId: string;
  feedback: LocalSignatureStyleFeedbackValue;
}): Promise<LocalSignatureStyleFeedback> {
  const { userKey, sessionId, messageId, feedback } = params;
  if (!userKey || !sessionId || !messageId) {
    throw new Error('Signature Style feedback requires userKey, sessionId, and messageId.');
  }
  if (!isFeedbackValue(feedback)) {
    throw new Error('Invalid Signature Style feedback value.');
  }

  const key = sessionKey(userKey, sessionId);
  return enqueueWrite(key, async () => {
    const map = await readSessionMapForWrite(userKey, sessionId);
    const now = new Date().toISOString();
    const existing = map.feedbackByMessageId[messageId];

    // One record per message: update in place, preserving the original createdAt.
    // TODO: Phase 1 - differentiate contextSource via handoff metadata.
    const record: LocalSignatureStyleFeedback = {
      schemaVersion: 1,
      userKey,
      sessionId,
      messageId,
      feedback,
      messageRole: 'assistant',
      contextSource: 'style_chat',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    map.feedbackByMessageId[messageId] = record;
    map.updatedAt = now;
    await AsyncStorage.setItem(key, JSON.stringify(map));
    return record;
  });
}

// ── Delete / sign-out safety helpers ──────────────────────────────────────────
// Implemented for Phase 0; wiring into sign-out / account deletion is deferred.

export async function clearLocalSignatureStyleForUser(userKey: string): Promise<void> {
  if (!userKey) return;
  const prefix = `${SESSIONS_PREFIX}${userKey}/`;
  const keys = await AsyncStorage.getAllKeys();
  const toRemove = keys.filter((k) => k.startsWith(prefix));
  if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
}

export async function clearAllLocalSignatureStyle(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const toRemove = keys.filter((k) => k.startsWith(SIGNATURE_STYLE_NAMESPACE));
  if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
}
