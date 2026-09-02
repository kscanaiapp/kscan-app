// Durable Elise composer drafts (UX addendum 2).
//
// styleChatAttachmentStore keeps drafts in memory, which survives navigation,
// a scanner round trip and a remount — but not a crash, a force-quit or an OS
// process kill. Losing a long, carefully typed styling question that way is a
// real failure, so the TEXT (and only the text) is mirrored to device storage.
//
// WHAT IS DEPLIBERATELY NOT PERSISTED
//   - attachments and their local image URIs. Those are selection-layer state
//     pointing at this device's cache; a URI that outlives the cache entry is a
//     broken reference, and writing media pointers to durable storage is a
//     privacy surface this feature does not need.
//   - anything for a signed-out composer. A draft with no owner has no one to
//     restore it TO, and storing it would create exactly the ownerless record
//     an actor switch could then pick up.
//
// ACTOR BINDING IS THE WHOLE DESIGN
//   Every record carries the actor it belongs to, every read requires the
//   expected actor and returns null on any mismatch, and the actor transition
//   in AuthSessionContext clears the store outright. The read check is not
//   redundant with the clear: the clear is asynchronous and fire-and-forget, so
//   a restore racing it must still fail closed on its own.
//
// The in-memory store remains the authority during a session. This is a
// recovery source consulted when memory has none, never a second live copy.

import AsyncStorage from '@react-native-async-storage/async-storage';

export const STYLE_CHAT_DRAFTS_KEY = '@style_chat_v1/composer/drafts';

/** Long enough for a considered styling question, short enough to stay small. */
export const MAX_PERSISTED_DRAFT_CHARS = 1000;
/** Only the most recently touched conversations keep a durable draft. */
export const MAX_PERSISTED_DRAFTS = 10;

type PersistedDraft = {
  sessionId: string;
  text: string;
  updatedAt: number;
};

type PersistedDraftFile = {
  version: 1;
  actorId: string;
  drafts: PersistedDraft[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Total: returns null for anything that is not a well-formed record. */
export function parsePersistedDraftFile(raw: string | null): PersistedDraftFile | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (typeof parsed.actorId !== 'string' || !parsed.actorId) return null;
  if (!Array.isArray(parsed.drafts)) return null;

  const drafts: PersistedDraft[] = [];
  for (const entry of parsed.drafts) {
    if (!isRecord(entry)) continue;
    if (typeof entry.sessionId !== 'string' || !entry.sessionId) continue;
    if (typeof entry.text !== 'string') continue;
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : 0;
    drafts.push({
      sessionId: entry.sessionId,
      text: entry.text.slice(0, MAX_PERSISTED_DRAFT_CHARS),
      updatedAt,
    });
  }
  return { version: 1, actorId: parsed.actorId, drafts };
}

/**
 * Pure: apply one draft edit to a file, returning the file to write.
 *
 * A record belonging to a different actor is REPLACED, never merged — the
 * arriving actor's storage must not inherit a single row of the departed one's.
 * Empty text removes the entry rather than storing a blank.
 */
export function applyDraftEdit(
  existing: PersistedDraftFile | null,
  input: { actorId: string; sessionId: string; text: string; now: number },
): PersistedDraftFile {
  const base =
    existing && existing.actorId === input.actorId
      ? existing.drafts.filter((draft) => draft.sessionId !== input.sessionId)
      : [];

  const text = input.text.slice(0, MAX_PERSISTED_DRAFT_CHARS);
  const next = text.trim()
    ? [{ sessionId: input.sessionId, text, updatedAt: input.now }, ...base]
    : base;

  return {
    version: 1,
    actorId: input.actorId,
    drafts: next
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_PERSISTED_DRAFTS),
  };
}

/** Pure: the durable draft for one actor + session, or '' when there is none. */
export function selectPersistedDraft(
  file: PersistedDraftFile | null,
  actorId: string | null,
  sessionId: string,
): string {
  if (!file || !actorId || file.actorId !== actorId) return '';
  return file.drafts.find((draft) => draft.sessionId === sessionId)?.text ?? '';
}

/**
 * Mirror one composer edit to durable storage. Best-effort and never awaited
 * into typing: a storage failure loses the recovery copy, never the keystroke.
 */
export async function persistStyleChatDraft(input: {
  actorId: string | null;
  sessionId: string;
  text: string;
}): Promise<void> {
  if (!input.actorId || !input.sessionId) return;
  try {
    const existing = parsePersistedDraftFile(await AsyncStorage.getItem(STYLE_CHAT_DRAFTS_KEY));
    const next = applyDraftEdit(existing, {
      actorId: input.actorId,
      sessionId: input.sessionId,
      text: input.text,
      now: Date.now(),
    });
    if (next.drafts.length === 0) {
      await AsyncStorage.removeItem(STYLE_CHAT_DRAFTS_KEY);
      return;
    }
    await AsyncStorage.setItem(STYLE_CHAT_DRAFTS_KEY, JSON.stringify(next));
  } catch {
    // Durable drafts are a convenience; the in-memory store remains authoritative.
  }
}

/** Read back a durable draft. Returns '' for any actor mismatch or bad record. */
export async function readStyleChatDraft(input: {
  actorId: string | null;
  sessionId: string;
}): Promise<string> {
  if (!input.actorId || !input.sessionId) return '';
  try {
    const file = parsePersistedDraftFile(await AsyncStorage.getItem(STYLE_CHAT_DRAFTS_KEY));
    return selectPersistedDraft(file, input.actorId, input.sessionId);
  } catch {
    return '';
  }
}

/**
 * Drop every durable draft. Called from the one place this project resets
 * actor-scoped runtime state, so a departed actor's unsent words do not sit on
 * the device waiting for the next account.
 */
export async function clearStyleChatDrafts(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STYLE_CHAT_DRAFTS_KEY);
  } catch {
    // A failed clear still cannot leak: every read requires the expected actor.
  }
}
