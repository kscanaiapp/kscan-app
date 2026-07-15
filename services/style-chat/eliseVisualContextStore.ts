// Session-scoped and actor-scoped visual context for Elise.
//
// Rules:
// - In-memory only. No AsyncStorage, no Supabase, no image bytes.
// - One active visual context per actor + session.
// - Replacements are explicit; stale async results are rejected by revision.
// - Sign-out / actor change clears the store.

import type { EliseVisualContext } from '../../types/eliseVisualContext';

type StoreEntry = {
  context: EliseVisualContext | null;
  revision: number;
};

const store = new Map<string, StoreEntry>();
const listeners = new Set<() => void>();
let revisionCounter = 0;

function key(actorKey: string, sessionId: string): string {
  return `${actorKey}:${sessionId}`;
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Listener failures never corrupt the store.
    }
  }
}

function getEntry(actorKey: string, sessionId: string): StoreEntry {
  const k = key(actorKey, sessionId);
  let entry = store.get(k);
  if (!entry) {
    entry = { context: null, revision: 0 };
    store.set(k, entry);
  }
  return entry;
}

export function subscribeToVisualContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVisualContext(
  actorKey: string,
  sessionId: string,
): EliseVisualContext | null {
  return getEntry(actorKey, sessionId).context;
}

export function getVisualContextRevision(actorKey: string, sessionId: string): number {
  return getEntry(actorKey, sessionId).revision;
}

/**
 * Set (or replace) the visual context for an actor/session.
 * Returns the minted revision token. Callers doing async work must later verify
 * the revision is still current before applying updates.
 */
export function setVisualContext(
  actorKey: string,
  sessionId: string,
  context: EliseVisualContext | null,
): number {
  const entry = getEntry(actorKey, sessionId);
  entry.revision = ++revisionCounter;
  entry.context = context;
  if (context) {
    entry.context.revision = entry.revision;
  }
  notify();
  return entry.revision;
}

/**
 * Update the context in place only if the supplied revision is still current.
 * This prevents stale async work (superseded uploads, session switches, etc.)
 * from resurrecting or overwriting newer state.
 */
export function updateVisualContextIfCurrent(
  actorKey: string,
  sessionId: string,
  revision: number,
  updater: (ctx: EliseVisualContext) => EliseVisualContext,
): boolean {
  const entry = getEntry(actorKey, sessionId);
  if (entry.revision !== revision) return false;
  if (!entry.context) return false;
  entry.context = updater(entry.context);
  notify();
  return true;
}

export function removeVisualContext(actorKey: string, sessionId: string): void {
  const entry = getEntry(actorKey, sessionId);
  entry.revision = ++revisionCounter;
  entry.context = null;
  notify();
}

/**
 * Clear all visual-context state. Called on sign-out / actor change.
 */
export function resetVisualContextStore(): void {
  store.clear();
  notify();
}

/**
 * True when the supplied revision token is still the active one for the actor/session.
 */
export function isVisualContextRevisionCurrent(
  actorKey: string,
  sessionId: string,
  revision: number,
): boolean {
  return getEntry(actorKey, sessionId).revision === revision;
}
