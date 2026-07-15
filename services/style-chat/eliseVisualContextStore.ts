// Session-scoped and actor-scoped visual context collection for Elise.
//
// Rules:
// - In-memory only. No AsyncStorage, no Supabase, no image bytes.
// - Up to ELISE_VISUAL_CONTEXT_MAX_ENTRIES per actor + session.
// - Replacements are explicit; stale async results are rejected by revision.
// - Sign-out / actor change clears the store and returns preview URIs for cleanup.

import {
  ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
  type EliseVisualContextCollection,
  type EliseVisualContextEntry,
  type VisualContextMemoryCandidateInput,
} from '../../types/eliseVisualContext';

type StoreEntry = {
  collection: EliseVisualContextCollection;
  revision: number;
};

export type VisualContextScanIntent = {
  id: string;
  actorKey: string;
  sessionId: string;
  expectedRevision: number;
  createdAt: number;
};

const store = new Map<string, StoreEntry>();
const scanIntents = new Map<string, VisualContextScanIntent>();
const listeners = new Set<() => void>();
let revisionCounter = 0;
let intentCounter = 0;
const SCAN_INTENT_TTL_MS = 15 * 60 * 1000;
const MAX_SCAN_INTENTS = 20;

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
    entry = {
      collection: {
        entries: [],
        focusedEntryId: null,
        maxEntries: ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
        revision: 0,
      },
      revision: 0,
    };
    store.set(k, entry);
  }
  return entry;
}

function currentRevision(actorKey: string, sessionId: string): number {
  return store.get(key(actorKey, sessionId))?.revision ?? 0;
}

function mintRevision(entry: StoreEntry, invalidateScanIntent: boolean): number {
  const revision = ++revisionCounter;
  if (invalidateScanIntent) entry.revision = revision;
  return revision;
}

function pruneScanIntents(now = Date.now(), reserveSlot = false): void {
  for (const [id, intent] of scanIntents) {
    if (now - intent.createdAt > SCAN_INTENT_TTL_MS) scanIntents.delete(id);
  }
  const maximumSize = reserveSlot ? MAX_SCAN_INTENTS - 1 : MAX_SCAN_INTENTS;
  while (scanIntents.size > maximumSize) {
    const oldest = scanIntents.keys().next().value as string | undefined;
    if (!oldest) break;
    scanIntents.delete(oldest);
  }
}

export function subscribeToVisualContextCollection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVisualContextCollection(
  actorKey: string,
  sessionId: string,
): EliseVisualContextCollection | null {
  return store.get(key(actorKey, sessionId))?.collection ?? null;
}

export function getVisualContextCollectionRevision(actorKey: string, sessionId: string): number {
  return currentRevision(actorKey, sessionId);
}

/** Create an opaque scanner return intent without exposing actor identity in the route. */
export function createVisualContextScanIntent(actorKey: string, sessionId: string): string {
  pruneScanIntents(Date.now(), true);
  for (const [id, intent] of scanIntents) {
    if (intent.actorKey === actorKey && intent.sessionId === sessionId) scanIntents.delete(id);
  }
  const id = `vc-scan-${Date.now().toString(36)}-${(++intentCounter).toString(36)}`;
  scanIntents.set(id, {
    id,
    actorKey,
    sessionId,
    expectedRevision: currentRevision(actorKey, sessionId),
    createdAt: Date.now(),
  });
  return id;
}

export function getVisualContextScanIntent(id: string): VisualContextScanIntent | null {
  pruneScanIntents();
  return scanIntents.get(id) ?? null;
}

export function consumeVisualContextScanIntent(id: string): VisualContextScanIntent | null {
  const intent = getVisualContextScanIntent(id);
  scanIntents.delete(id);
  return intent;
}

/**
 * Replace the entire collection for an actor/session.
 * Returns the minted revision token. Callers doing async work must later verify
 * the revision is still current before applying updates.
 */
export function setVisualContextCollection(
  actorKey: string,
  sessionId: string,
  collection: Omit<EliseVisualContextCollection, 'revision'>,
): number {
  const entry = getEntry(actorKey, sessionId);
  if (collection.entries.length > ELISE_VISUAL_CONTEXT_MAX_ENTRIES) {
    throw new Error('Visual context collection exceeds capacity');
  }
  const revision = mintRevision(entry, true);
  entry.collection = {
    ...collection,
    entries: [...collection.entries],
    maxEntries: ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
    revision,
  };
  notify();
  return revision;
}

function nextOrder(collection: EliseVisualContextCollection): number {
  if (!collection.entries.length) return 1;
  return Math.max(...collection.entries.map((e) => e.order)) + 1;
}

/**
 * Append a new entry if the collection has room.
 * Returns the appended entry and the new revision, or null when at capacity.
 */
export function appendVisualContextEntry(
  actorKey: string,
  sessionId: string,
  entry: EliseVisualContextEntry,
): { entry: EliseVisualContextEntry; revision: number } | null {
  const entryState = getEntry(actorKey, sessionId);
  const collection = entryState.collection;
  if (collection.entries.length >= ELISE_VISUAL_CONTEXT_MAX_ENTRIES) return null;
  if (collection.entries.some((existing) => existing.id === entry.id)) return null;

  const revision = mintRevision(entryState, true);
  const orderedEntry = {
    ...entry,
    order: entry.order || nextOrder(collection),
    revision,
  };
  entryState.collection = {
    ...collection,
    entries: [...collection.entries, orderedEntry],
    maxEntries: ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
    revision,
  };
  notify();
  return { entry: orderedEntry, revision };
}

export function removeVisualContextEntry(
  actorKey: string,
  sessionId: string,
  entryId: string,
): boolean {
  const entryState = getEntry(actorKey, sessionId);
  const collection = entryState.collection;
  const entries = collection.entries.filter((e) => e.id !== entryId);
  if (entries.length === collection.entries.length) return false;

  const revision = mintRevision(entryState, true);
  entryState.collection = {
    ...collection,
    entries,
    focusedEntryId: collection.focusedEntryId === entryId ? null : collection.focusedEntryId,
    revision,
  };
  notify();
  return true;
}

/**
 * Update an entry in place only if the supplied revision is still current.
 * This prevents stale async work (superseded uploads, session switches, etc.)
 * from resurrecting or overwriting newer state.
 */
export function updateVisualContextEntryIfCurrent(
  actorKey: string,
  sessionId: string,
  entryId: string,
  revision: number,
  updater: (entry: EliseVisualContextEntry) => EliseVisualContextEntry,
): boolean {
  const entryState = getEntry(actorKey, sessionId);
  const index = entryState.collection.entries.findIndex((e) => e.id === entryId);
  if (index === -1) return false;
  if (entryState.collection.entries[index].revision !== revision) return false;

  const nextRevision = mintRevision(entryState, false);
  const entries = [...entryState.collection.entries];
  entries[index] = {
    ...updater(entries[index]),
    revision: nextRevision,
  };
  entryState.collection = {
    ...entryState.collection,
    entries,
    revision: nextRevision,
  };
  notify();
  return true;
}

export function isVisualContextEntryRevisionCurrent(
  actorKey: string,
  sessionId: string,
  entryId: string,
  revision: number,
): boolean {
  return getVisualContextCollection(actorKey, sessionId)?.entries.some(
    (entry) => entry.id === entryId && entry.revision === revision,
  ) ?? false;
}

/**
 * Start a new async lifecycle for one entry and return its entry-scoped token.
 * Other collection mutations must not invalidate the work for this entry.
 */
export function restartVisualContextEntry(
  actorKey: string,
  sessionId: string,
  entryId: string,
  updater: (entry: EliseVisualContextEntry) => EliseVisualContextEntry,
): number | null {
  const entryState = getEntry(actorKey, sessionId);
  const index = entryState.collection.entries.findIndex((e) => e.id === entryId);
  if (index === -1) return null;

  const revision = mintRevision(entryState, false);
  const entries = [...entryState.collection.entries];
  entries[index] = {
    ...updater(entries[index]),
    revision,
  };
  entryState.collection = { ...entryState.collection, entries, revision };
  notify();
  return revision;
}

export function setVisualContextFocusedEntry(
  actorKey: string,
  sessionId: string,
  entryId: string | null,
): boolean {
  const entryState = getEntry(actorKey, sessionId);
  if (entryId && !entryState.collection.entries.some((e) => e.id === entryId)) return false;
  if (entryState.collection.focusedEntryId === entryId) return true;
  const revision = mintRevision(entryState, false);
  entryState.collection = {
    ...entryState.collection,
    focusedEntryId: entryId,
    revision,
  };
  notify();
  return true;
}

export function clearVisualContextCollection(actorKey: string, sessionId: string): number {
  const entryState = getEntry(actorKey, sessionId);
  const revision = mintRevision(entryState, true);
  entryState.collection = {
    entries: [],
    focusedEntryId: null,
    maxEntries: ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
    revision,
  };
  notify();
  return revision;
}

/**
 * Clear all visual-context state. Called on sign-out / actor change.
 * Returns the set of local preview URIs that callers should clean up.
 */
export function resetVisualContextStore(): string[] {
  const previewUris = [
    ...new Set(
      [...store.values()]
        .flatMap((entry) => entry.collection.entries.map((e) => e.sanitizedPreviewUri))
        .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0),
    ),
  ];
  store.clear();
  scanIntents.clear();
  notify();
  return previewUris;
}

/**
 * True when the supplied revision token is still the active one for the actor/session.
 */
export function isVisualContextRevisionCurrent(
  actorKey: string,
  sessionId: string,
  revision: number,
): boolean {
  return currentRevision(actorKey, sessionId) === revision;
}

/**
 * Build a memory-candidate projection from an explicitly focused ready entry.
 * Only metadata fields supported by actual evidence are included.
 */
export function getVisualContextMemoryCandidate(
  actorKey: string,
  sessionId: string,
): VisualContextMemoryCandidateInput | null {
  const collection = getVisualContextCollection(actorKey, sessionId);
  if (!collection) return null;
  if (!collection.focusedEntryId) return null;
  const entry = collection.entries.find(
    (e) => e.id === collection.focusedEntryId && e.status === 'ready',
  ) ?? null;
  if (!entry) return null;
  return {
    source: entry.source,
    title: entry.title,
    category: entry.category ?? null,
    colors: entry.colors ?? null,
    materials: entry.materials ?? null,
    styleAttributes: entry.styleAttributes ?? null,
    brand: entry.brand ?? null,
  };
}
